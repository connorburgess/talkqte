use super::*;
use block2::RcBlock;
use dispatch2::{DispatchQueue, DispatchRetained};
use objc2::{
    define_class, msg_send, rc::Retained, runtime::ProtocolObject, AnyThread, DefinedClass,
};
use objc2_foundation::{NSArray, NSError, NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{
    SCContentFilter, SCDisplay, SCRunningApplication, SCStream, SCStreamConfiguration,
    SCStreamDelegate, SCStreamOutput, SCStreamOutputType, SCWindow,
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
    /// The supplied output must be safe to call on a dedicated serial dispatch
    /// queue, honor this Start's cancellation/source boundary, and not access
    /// thread-confined state from its callback. It must not retain borrowed media,
    /// allocate, block, log, record or infer in the callback. These requirements
    /// are not established by implementing the Objective-C output protocol.
    /// Run on a worker, never a UI thread or output callback. Keep polling until
    /// Released, including after cancellation; no real capture is authorized by
    /// compiling this feature or constructing Selection.
    pub unsafe fn begin(
        start: Start,
        selection: Selection,
        output: Retained<ProtocolObject<dyn SCStreamOutput>>,
    ) -> Result<Self, Failure> {
        if start.lease.control.is_cancelled() {
            return Err(Failure::Cancelled);
        }
        if start.lease.control.0.application != selection.source {
            return Err(Failure::ReviewChanged);
        }
        let delegate = StreamDelegate::new(start.lease.control.clone());
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
        let driver = Stream {
            stream,
            delegate,
            output,
            queue,
            _selection: selection,
            start: None,
            stop: None,
        };
        Owner::begin(start, driver).map(Self)
    }

    pub fn poll(&mut self) -> Status {
        self.0.poll()
    }

    /// Only retries a completed Stop or output-removal failure. A pending native
    /// request has no retry path, so a timeout cannot start overlapping cleanup.
    pub fn retry_cleanup(&mut self) -> bool {
        self.0.retry_cleanup()
    }
}

define_class!(
    // SAFETY: NSObject has no subclass requirements. Immutable ivars contain
    // only operation-scoped atomics/Arc state; callbacks never touch native state.
    #[unsafe(super = NSObject)]
    #[name = "TalkQTEAudioStreamDelegate"]
    #[ivars = StreamFault]
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
    fn new(control: Control) -> Retained<Self> {
        let this = Self::alloc().set_ivars(StreamFault::new(control));
        // SAFETY: NSObject initialization with the correct signature and ivars.
        unsafe { msg_send![super(this), init] }
    }
}

struct Stream {
    stream: Retained<SCStream>,
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

impl Driver for Stream {
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
        self.stop = Some(completion(slot));
        // SAFETY: one outstanding Stop; retries replace only a completed block.
        unsafe {
            self.stream
                .stopCaptureWithCompletionHandler(self.stop.as_deref());
        }
    }
    fn remove_output(&mut self) -> bool {
        // SAFETY: successful Stop was observed; the retained exact output is
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
}
