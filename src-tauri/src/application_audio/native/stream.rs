use super::*;
use super::{
    clock::{ClockBinding, NativeReader},
    output::AudioOutput,
};
use crate::application_audio::handoff::{Format, MAX_BLOCKS};
use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::{
    define_class, msg_send, rc::Retained, runtime::ProtocolObject, AnyThread, DefinedClass,
};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCRunningApplication, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamErrorCode, SCStreamErrorDomain, SCStreamOutput, SCStreamOutputType,
    SCWindow,
};
use std::sync::atomic::AtomicU64;

/// A retained native application instance, not a name used to find another app.
/// Construct only after an explicitly authorized selection/enumeration flow.
/// It stays on its constructing thread, as does the eventual native owner.
pub struct Selection {
    source: Application,
    display: Retained<SCDisplay>,
    application: Retained<SCRunningApplication>,
}

impl Selection {
    pub fn new(
        display: Retained<SCDisplay>,
        application: Retained<SCRunningApplication>,
    ) -> Result<Self, Failure> {
        if !objc2::available!(macos = 14.0) {
            return Err(Failure::Unavailable);
        }
        static NEXT: AtomicU64 = AtomicU64::new(1);
        let id = NEXT
            .fetch_update(Ordering::Relaxed, Ordering::Relaxed, |id| id.checked_add(1))
            .map_err(|_| Failure::Unavailable)?;
        // SAFETY: retained native application on its owner thread, API available
        // before our explicitly checked feature floor. No enumeration is called.
        let name = unsafe { application.applicationName() }.to_string();
        let source = Application::new(format!("native-application-{id}"), name)?;
        Ok(Self {
            source,
            display,
            application,
        })
    }

    pub fn application(&self) -> &Application {
        &self.source
    }
}

/// Poll on the constructing worker thread until Released. No Drop or timeout
/// can substitute for confirmed native Stop and serial callback-queue drain.
/// Abandoning an unreleased owner quarantines its resources/grant until exit.
/// This is development scaffolding, not connected to the application runtime.
/// Native ownership cannot move across threads:
///
/// ```compile_fail
/// fn require_send<T: Send>() {}
/// require_send::<talkqte_lib::application_audio::native::NativeOwner>();
/// ```
#[must_use = "Keep polling native cleanup until Released; Drop is not a Stop acknowledgement"]
pub struct NativeOwner(Owner<Stream>);

impl NativeOwner {
    /// Begin exactly the approved selection, registering only an audio output.
    /// No enumeration, picker, microphone, file, network or model API is called.
    ///
    /// # Safety
    /// The host must establish the supplied host/session clock relationship and
    /// validate CoreMedia copying latency/allocation for live callback use.
    /// Native buffers must remain valid and immutable during their callbacks.
    /// The built-in output is registered only on its dedicated serial queue.
    /// Run on a worker, never a UI thread or output callback. Keep polling until
    /// Released, including after cancellation; no real capture is authorized by
    /// compiling this feature or constructing Selection.
    pub unsafe fn begin(
        mut start: Start,
        selection: Selection,
        clock: ClockBinding,
    ) -> Result<(Self, NativeReader), Failure> {
        if start.lease.control.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        if start.lease.control.0.application != selection.source {
            return Err(Failure::ReviewChanged);
        }
        let pcm = pcm::PcmReader::from_first_sample();
        let (input, reader) = start
            .handoff(Format::new(16_000, 1).unwrap(), MAX_BLOCKS)
            .map_err(|_| Failure::StartFailed)?;
        let consumer_closed = input.consumer_closed_signal();
        let fault = Arc::new(StreamFault::new(start.lease.control.clone()));
        let output = AudioOutput::new(input, pcm, fault.clone());
        let origin = output.origin();
        let output = ProtocolObject::from_retained(output);
        let delegate = StreamDelegate::new(fault);
        let queue = DispatchQueue::new("talkqte.application-audio", None);
        let applications = NSArray::from_slice(&[&*selection.application]);
        let exceptions = NSArray::<SCWindow>::new();
        // SAFETY: native objects remain on this thread; Selection checked the
        // OS floor. Positive application inclusion cannot turn into all-app
        // exclusion. Window exceptions are empty and the filter is never updated.
        let stream = unsafe {
            let filter = SCContentFilter::initWithDisplay_includingApplications_exceptingWindows(
                SCContentFilter::alloc(),
                &selection.display,
                &applications,
                &exceptions,
            );
            let config = SCStreamConfiguration::new();
            config.setCapturesAudio(true);
            config.setExcludesCurrentProcessAudio(true);
            config.setSampleRate(16_000);
            config.setChannelCount(1);
            let stream = SCStream::initWithFilter_configuration_delegate(
                SCStream::alloc(),
                &filter,
                &config,
                Some(ProtocolObject::from_ref(&*delegate)),
            );
            // The caller's callback contract and this serial queue satisfy the
            // binding's additional threading requirement. Only audio is attached.
            stream
                .addStreamOutput_type_sampleHandlerQueue_error(
                    &output,
                    SCStreamOutputType::Audio,
                    Some(&queue),
                )
                .map_err(|_| Failure::StartFailed)?;
            stream
        };
        let reader = NativeReader::new(reader, stream.clone(), origin, clock);
        let driver = Stream {
            stream,
            consumer_closed,
            delegate,
            output,
            queue,
            _selection: selection,
            start: None,
            stop: None,
        };
        Owner::begin(start, driver).map(|owner| (Self(owner), reader))
    }

    pub fn poll(&mut self) -> Status {
        self.0.poll()
    }

    /// Only retries a completed Stop or output-removal failure. A pending native
    /// request has no retry path, so a timeout cannot start overlapping cleanup.
    pub fn retry_cleanup(&mut self) -> bool {
        self.0.retry_cleanup()
    }

    /// Transfer cleanup polling to a task on this constructing worker thread.
    /// Read NativeReader alongside manual poll calls before this transfer; this
    /// blocking cleanup loop does not consume audio. Drop the reader to retire it.
    /// Send only the control handle to the host, then call NativeTask::run here.
    pub fn into_task(self) -> (NativeTask, task::TaskControl) {
        let (task, control) = task::Task::new(self.0);
        (NativeTask(task), control)
    }
}

/// Owns native cleanup independently of the host's control handle. Construct and
/// run on the same dedicated worker; this is not an abortable async task.
///
/// ```compile_fail
/// fn require_send<T: Send>() {}
/// require_send::<talkqte_lib::application_audio::native::NativeTask>();
/// ```
#[must_use = "Run on the owning worker until Released; dropping the task abandons cleanup"]
pub struct NativeTask(task::Task<Stream>);

impl NativeTask {
    /// Service native completions and explicit cleanup retries until Released.
    /// A missing completion or unretried failure keeps this worker and the grant
    /// reserved. Do not run on the UI thread, an audio callback or a shared pool
    /// whose shutdown requires this operation to finish within a deadline.
    pub fn run(self) -> Status {
        self.0.run()
    }
}

define_class!(
    // SAFETY: NSObject has no subclass requirements. Immutable ivars contain
    // only operation-scoped atomics/Arc state; callbacks never touch native state.
    #[unsafe(super = NSObject)]
    #[name = "TalkQTEAudioStreamDelegate"]
    #[ivars = Arc<StreamFault>]
    struct StreamDelegate;

    unsafe impl NSObjectProtocol for StreamDelegate {}

    unsafe impl SCStreamDelegate for StreamDelegate {
        #[unsafe(method(stream:didStopWithError:))]
        fn stopped(&self, _stream: &SCStream, _error: &NSError) {
            self.ivars().record();
        }
    }
);

impl StreamDelegate {
    fn new(fault: Arc<StreamFault>) -> Retained<Self> {
        let this = Self::alloc().set_ivars(fault);
        // SAFETY: NSObject initialization with the correct signature and ivars.
        unsafe { msg_send![super(this), init] }
    }
}

struct Stream {
    stream: Retained<SCStream>,
    consumer_closed: Arc<AtomicBool>,
    // Retain explicitly: the stream delegate relationship alone is not ownership.
    delegate: Retained<StreamDelegate>,
    output: Retained<ProtocolObject<dyn SCStreamOutput>>,
    queue: DispatchRetained<DispatchQueue>,
    _selection: Selection,
    start: Option<RcBlock<dyn Fn(*mut NSError)>>,
    stop: Option<RcBlock<dyn Fn(*mut NSError)>>,
}

fn completion(slot: Arc<AtomicU8>) -> RcBlock<dyn Fn(*mut NSError)> {
    RcBlock::new(move |error: *mut NSError| {
        // No native object crosses the callback boundary. Ignore duplicates.
        let _ = slot.compare_exchange(
            PENDING,
            if error.is_null() { SUCCEEDED } else { FAILED },
            Ordering::Release,
            Ordering::Relaxed,
        );
    })
}

fn stop_completion(slot: Arc<AtomicU8>) -> RcBlock<dyn Fn(*mut NSError)> {
    RcBlock::new(move |error: *mut NSError| {
        // This is a Stop completion, not an audio callback. Inspect only the
        // borrowed error's domain/code; retain no error or diagnostic text.
        // SAFETY: ScreenCaptureKit supplies a valid NSError for this callback,
        // or null on success. The framework domain exists since macOS 12.3.
        let outcome = match unsafe { error.as_ref() } {
            None => SUCCEEDED,
            Some(error)
                if error.code() == SCStreamErrorCode::AttemptToStopStreamState.0
                    && error
                        .domain()
                        .isEqualToString(unsafe { SCStreamErrorDomain }) =>
            {
                ALREADY_STOPPED
            }
            Some(_) => FAILED,
        };
        let _ = slot.compare_exchange(PENDING, outcome, Ordering::Release, Ordering::Relaxed);
    })
}

impl Driver for Stream {
    fn consumer_closed(&self) -> bool {
        self.consumer_closed.load(Ordering::Acquire)
    }
    fn stream_failed(&self) -> bool {
        self.delegate.ivars().failed.load(Ordering::Acquire)
    }
    fn start(&mut self, slot: Arc<AtomicU8>) {
        self.start = Some(completion(slot));
        // SAFETY: stream and block are retained until native cleanup; callback
        // only publishes an atomic result, irrespective of its calling thread.
        unsafe {
            self.stream
                .startCaptureWithCompletionHandler(self.start.as_deref());
        }
    }
    fn stop(&mut self, slot: Arc<AtomicU8>) {
        self.stop = Some(stop_completion(slot));
        // SAFETY: one outstanding Stop; retries replace only a completed block.
        unsafe {
            self.stream
                .stopCaptureWithCompletionHandler(self.stop.as_deref());
        }
    }
    fn remove_output(&mut self) -> bool {
        // SAFETY: Stop succeeded or explicitly reported already stopped; the exact output is
        // removed before enqueuing a fence on its sole serial callback queue.
        unsafe {
            self.stream
                .removeStreamOutput_type_error(&self.output, SCStreamOutputType::Audio)
                .is_ok()
        }
    }
    fn drain(&self, slot: Arc<AtomicBool>) {
        self.queue
            .exec_async(move || slot.store(true, Ordering::Release));
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn native_completion_records_only_first_result_without_reading_error_object() {
        let slot = Arc::new(AtomicU8::new(PENDING));
        let block = completion(slot.clone());
        // This sentinel is only compared with null; no NSError is constructed,
        // retained or dereferenced, and no ScreenCaptureKit API is invoked.
        block.call((std::ptr::NonNull::<NSError>::dangling().as_ptr(),));
        block.call((std::ptr::null_mut(),));
        assert_eq!(slot.load(Ordering::Acquire), FAILED);
        let fresh = Arc::new(AtomicU8::new(PENDING));
        completion(fresh.clone()).call((std::ptr::null_mut(),));
        assert_eq!(fresh.load(Ordering::Acquire), SUCCEEDED);
        assert_eq!(slot.load(Ordering::Acquire), FAILED);
    }

    #[test]
    fn stop_completion_accepts_only_the_specific_framework_not_running_error() {
        use objc2_foundation::ns_string;
        // Memory-only NSError fixtures; no capture, stream or permission API.
        let domain = unsafe { SCStreamErrorDomain };
        for (domain, code, expected) in [
            (
                domain,
                SCStreamErrorCode::AttemptToStopStreamState.0,
                ALREADY_STOPPED,
            ),
            (
                ns_string!("FictionalErrorDomain"),
                SCStreamErrorCode::AttemptToStopStreamState.0,
                FAILED,
            ),
            (
                domain,
                SCStreamErrorCode::FailedToStopAudioCapture.0,
                FAILED,
            ),
            (domain, SCStreamErrorCode::FailedToStart.0, FAILED),
        ] {
            let error = unsafe { NSError::errorWithDomain_code_userInfo(domain, code, None) };
            let ptr = Retained::as_ptr(&error).cast_mut();
            let slot = Arc::new(AtomicU8::new(PENDING));
            let block = stop_completion(slot.clone());
            block.call((ptr,));
            block.call((std::ptr::null_mut(),));
            assert_eq!(slot.load(Ordering::Acquire), expected);
            // This error must not turn a failed start into successful capture.
            let start = Arc::new(AtomicU8::new(PENDING));
            completion(start.clone()).call((ptr,));
            assert_eq!(start.load(Ordering::Acquire), FAILED);
        }
        let slot = Arc::new(AtomicU8::new(PENDING));
        stop_completion(slot.clone()).call((std::ptr::null_mut(),));
        assert_eq!(slot.load(Ordering::Acquire), SUCCEEDED);
    }
}
