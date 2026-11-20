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
use std::sync::atomic::{AtomicI64, AtomicU64};

/// A retained native application instance, not a name used to find another app.
/// Construct only after an explicitly authorized selection/enumeration flow.
/// It stays on its constructing thread, as does the eventual native owner.
pub struct Selection {
    source: Application,
    display: Retained<SCDisplay>,
    application: Retained<SCRunningApplication>,
    /// Its helper processes, captured with it and never listed on their own.
    helpers: Vec<Retained<SCRunningApplication>>,
}

impl Selection {
    pub fn new(
        display: Retained<SCDisplay>,
        application: Retained<SCRunningApplication>,
        traits: crate::application_audio::listing::Traits,
        helpers: Vec<Retained<SCRunningApplication>>,
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
        let source =
            Application::new(format!("native-application-{id}"), name)?.with_traits(traits);
        Ok(Self {
            source,
            display,
            application,
            helpers,
        })
    }

    #[cfg(all(debug_assertions, feature = "lab-evaluator"))]
    pub(crate) fn lab_allowed(&self) -> bool {
        self.lab_check() == crate::dev_lab_source::Check::Current
    }

    /// `lab_allowed`, naming a failed check and whether it is definitive.
    #[cfg(all(debug_assertions, feature = "lab-evaluator"))]
    pub(crate) fn lab_check(&self) -> crate::dev_lab_source::Check {
        // Plain retained SCK property reads plus process inspection, only on
        // this selection's owner thread. No filter mutation or reacquisition.
        crate::dev_lab_source::selection_check(
            unsafe { self.application.processID() },
            &unsafe { self.application.bundleIdentifier() }.to_string(),
            self.source.name(),
            self.helpers.len(),
        )
    }

    pub fn application(&self) -> &Application {
        &self.source
    }
}

/// Poll on the constructing worker thread until Released. No Drop or timeout
/// can substitute for confirmed native Stop and serial callback-queue drain.
/// Abandoning an unreleased owner quarantines its resources/grant until exit.
/// Development scaffolding, reached only through the feature's host command.
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
        #[cfg(all(debug_assertions, feature = "lab-evaluator"))]
        if !selection.lab_allowed() {
            return Err(Failure::SourceUnavailable);
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
        // The application and its helpers, which a browser plays sound from.
        let included: Vec<&SCRunningApplication> = std::iter::once(&*selection.application)
            .chain(selection.helpers.iter().map(|helper| &**helper))
            .collect();
        let applications = NSArray::from_slice(&included);
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
            let config = audio_only_configuration();
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
            start_code: Arc::new(AtomicI64::new(NO_CODE)),
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
        fn stopped(&self, _stream: &SCStream, error: &NSError) {
            // Only the error's domain and code are read; no text is kept.
            self.ivars().record_code(error_code(error));
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
    /// macOS's code for a failed start.
    start_code: Arc<AtomicI64>,
}

/// The ScreenCaptureKit code of `error`, or `OTHER_DOMAIN` for any other
/// framework's. Reads only the domain and code.
fn error_code(error: &NSError) -> i64 {
    // SAFETY: the framework domain constant exists since macOS 12.3.
    if error
        .domain()
        .isEqualToString(unsafe { SCStreamErrorDomain })
    {
        error.code() as i64
    } else {
        OTHER_DOMAIN
    }
}

fn completion(slot: Arc<AtomicU8>, code: Arc<AtomicI64>) -> RcBlock<dyn Fn(*mut NSError)> {
    RcBlock::new(move |error: *mut NSError| {
        // No native object crosses the callback boundary. Ignore duplicates.
        // SAFETY: ScreenCaptureKit supplies a valid NSError, or null on success.
        let outcome = match unsafe { error.as_ref() } {
            None => SUCCEEDED,
            Some(error) => {
                let _ = code.compare_exchange(
                    NO_CODE,
                    error_code(error),
                    Ordering::Release,
                    Ordering::Relaxed,
                );
                FAILED
            }
        };
        let _ = slot.compare_exchange(PENDING, outcome, Ordering::Release, Ordering::Relaxed);
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
        #[cfg(all(debug_assertions, feature = "lab-evaluator"))]
        self.delegate
            .ivars()
            .inspect_lab_source(std::time::Instant::now(), || self._selection.lab_check());
        self.consumer_closed.load(Ordering::Acquire)
    }
    fn stream_failed(&self) -> bool {
        self.delegate.ivars().failed.load(Ordering::Acquire)
    }
    fn start_code(&self) -> i64 {
        self.start_code.load(Ordering::Acquire)
    }
    fn stream_code(&self) -> i64 {
        self.delegate.ivars().code.load(Ordering::Acquire)
    }
    fn stream_detail(&self) -> Option<String> {
        #[cfg(all(debug_assertions, feature = "lab-evaluator"))]
        if let Some(detail) = self.delegate.ivars().lab_detail() {
            return Some(detail);
        }
        self.delegate.ivars().refused_detail()
    }
    fn start(&mut self, slot: Arc<AtomicU8>) {
        self.start = Some(completion(slot, self.start_code.clone()));
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

/// Request 16 kHz mono audio for the selected application. Only an audio
/// output is attached; this code does not read or store video frames.
/// Video settings request 2x2 dimensions, a one-second minimum frame interval
/// and no cursor. Actual hardware acceptance, cadence and CPU impact are
/// unverified; these settings are not a claim about the API's minimums.
fn audio_only_configuration() -> objc2::rc::Retained<SCStreamConfiguration> {
    // SAFETY: plain property setters on a new, unshared configuration.
    unsafe {
        let config = SCStreamConfiguration::new();
        config.setCapturesAudio(true);
        config.setExcludesCurrentProcessAudio(true);
        config.setSampleRate(16_000);
        config.setChannelCount(1);
        config.setWidth(UNUSED_VIDEO_SIZE);
        config.setHeight(UNUSED_VIDEO_SIZE);
        config.setMinimumFrameInterval(UNUSED_VIDEO_INTERVAL);
        config.setShowsCursor(false);
        config
    }
}

/// Requested video dimensions; no screen output is attached.
const UNUSED_VIDEO_SIZE: usize = 2;
/// Requested minimum interval between video frames.
const UNUSED_VIDEO_INTERVAL: objc2_core_media::CMTime = objc2_core_media::CMTime {
    value: 1,
    timescale: 1,
    flags: objc2_core_media::CMTimeFlags::Valid,
    epoch: 0,
};

#[cfg(test)]
mod tests {
    use super::*;

    #[cfg(all(debug_assertions, feature = "lab-evaluator"))]
    #[test]
    fn active_identity_loss_cancels_but_prior_or_concurrent_stop_dominates() {
        use crate::application_audio::Gate;
        let gate = Gate::default();
        let review = gate
            .review(
                Application::new(
                    "fictional-player".into(),
                    crate::dev_lab_source::PLAYER.into(),
                )
                .unwrap(),
            )
            .unwrap();
        let control = review.control();
        let fault = StreamFault::new(control.clone());
        fault.inspect_lab_source(std::time::Instant::now(), || {
            crate::dev_lab_source::Check::Gone("process_gone")
        });
        assert!(control.is_cancelled());
        assert!(fault.failed.load(Ordering::Acquire));
        // TalkQTE's own code, not ScreenCaptureKit's -3815, and the check named.
        assert_eq!(
            fault.code.load(Ordering::Acquire),
            super::super::LAB_SOURCE_LOST
        );
        assert_eq!(
            fault.lab_detail().as_deref(),
            Some("lab source check process_gone failed: the player is gone or was replaced")
        );
        drop(review);
        for concurrent in [false, true] {
            let review = gate
                .review(
                    Application::new(
                        "fictional-next".into(),
                        crate::dev_lab_source::PLAYER.into(),
                    )
                    .unwrap(),
                )
                .unwrap();
            let control = review.control();
            let fault = StreamFault::new(control.clone());
            if !concurrent {
                control.cancel();
            }
            let mut inspected = false;
            fault.inspect_lab_source(std::time::Instant::now(), || {
                inspected = true;
                control.cancel();
                crate::dev_lab_source::Check::Gone("process_gone")
            });
            assert_eq!(inspected, concurrent);
            assert!(!fault.failed.load(Ordering::Acquire));
            assert_eq!(fault.code.load(Ordering::Acquire), NO_CODE);
        }
    }

    /// A lab source checked every 20 ms for two minutes, as the owner loop
    /// does. At 110 s an application switch makes the check fail for half a
    /// second; the source must carry on. Only a failure that lasts the grace
    /// period ends it, with TalkQTE's own code and the check named.
    #[cfg(all(debug_assertions, feature = "lab-evaluator"))]
    #[test]
    fn a_transient_identity_failure_past_110_s_does_not_end_the_source_but_a_lasting_one_does() {
        use crate::application_audio::Gate;
        use crate::dev_lab_source::Check;
        use std::time::{Duration, Instant};
        let gate = Gate::default();
        let review = gate
            .review(
                Application::new(
                    "fictional-player".into(),
                    crate::dev_lab_source::PLAYER.into(),
                )
                .unwrap(),
            )
            .unwrap();
        let control = review.control();
        let fault = StreamFault::new(control.clone());
        let start = Instant::now();
        let poll = Duration::from_millis(20);
        let mut at = Duration::ZERO;
        while at < Duration::from_secs(120) {
            let switching = at >= Duration::from_secs(110) && at < Duration::from_millis(110_500);
            fault.inspect_lab_source(start + at, || {
                if switching {
                    Check::Transient("running_application")
                } else {
                    Check::Current
                }
            });
            assert!(!control.is_cancelled(), "ended at {at:?}");
            at += poll;
        }
        assert!(!fault.failed.load(Ordering::Acquire));
        assert_eq!(fault.code.load(Ordering::Acquire), NO_CODE);
        // The same failure, lasting: it ends the source once the grace is spent.
        let lasting = at;
        while at < lasting + super::super::LAB_SOURCE_GRACE + poll * 2 {
            fault.inspect_lab_source(start + at, || Check::Transient("bundle_identifier"));
            let spent = at - lasting >= super::super::LAB_SOURCE_GRACE;
            assert_eq!(control.is_cancelled(), spent, "at {:?}", at - lasting);
            at += poll;
        }
        assert_eq!(
            fault.code.load(Ordering::Acquire),
            super::super::LAB_SOURCE_LOST
        );
        assert_eq!(
            fault.lab_detail().as_deref(),
            Some("lab source check bundle_identifier kept failing for 2 s")
        );
        // The log's label tells it apart from ScreenCaptureKit's own source_gone.
        let code = fault.code.load(Ordering::Acquire);
        let problem = super::super::classify(code, Problem::StreamFailed);
        assert_eq!(super::super::label(problem, code), "lab_source_lost");
        let macos = SCStreamErrorCode::NoCaptureSource.0 as i64;
        let problem = super::super::classify(macos, Problem::StreamFailed);
        assert_eq!(super::super::label(problem, macos), "source_gone");
    }

    #[test]
    fn the_stream_requests_audio_and_bounded_unused_video_settings() {
        // A memory-only configuration object; no stream, capture or permission.
        let config = audio_only_configuration();
        let interval = unsafe { config.minimumFrameInterval() };
        unsafe {
            assert!(config.capturesAudio());
            assert!(config.excludesCurrentProcessAudio());
            assert_eq!(config.sampleRate(), 16_000);
            assert_eq!(config.channelCount(), 1);
            // Assert the requested properties, not delivered frame behavior.
            assert_eq!((config.width(), config.height()), (2, 2));
            assert!(!config.showsCursor());
        }
        assert_eq!((interval.value, interval.timescale), (1, 1));
        assert!(interval
            .flags
            .contains(objc2_core_media::CMTimeFlags::Valid));
    }

    #[test]
    fn a_start_completion_records_only_its_first_result_and_the_first_error_code() {
        // A memory-only NSError fixture; no capture, stream or permission API.
        let domain = unsafe { SCStreamErrorDomain };
        let error = unsafe {
            NSError::errorWithDomain_code_userInfo(domain, SCStreamErrorCode::UserDeclined.0, None)
        };
        let slot = Arc::new(AtomicU8::new(PENDING));
        let code = Arc::new(AtomicI64::new(NO_CODE));
        let block = completion(slot.clone(), code.clone());
        block.call((Retained::as_ptr(&error).cast_mut(),));
        block.call((std::ptr::null_mut(),));
        assert_eq!(slot.load(Ordering::Acquire), FAILED);
        assert_eq!(
            code.load(Ordering::Acquire),
            SCStreamErrorCode::UserDeclined.0 as i64
        );
        let (fresh, none) = (
            Arc::new(AtomicU8::new(PENDING)),
            Arc::new(AtomicI64::new(NO_CODE)),
        );
        completion(fresh.clone(), none.clone()).call((std::ptr::null_mut(),));
        assert_eq!(fresh.load(Ordering::Acquire), SUCCEEDED);
        assert_eq!(none.load(Ordering::Acquire), NO_CODE);
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
            let start_code = Arc::new(AtomicI64::new(NO_CODE));
            completion(start.clone(), start_code.clone()).call((ptr,));
            assert_eq!(start.load(Ordering::Acquire), FAILED);
            // Another framework's code is never mistaken for one of these.
            let kept = if domain.isEqualToString(unsafe { SCStreamErrorDomain }) {
                code as i64
            } else {
                OTHER_DOMAIN
            };
            assert_eq!(start_code.load(Ordering::Acquire), kept);
        }
        let slot = Arc::new(AtomicU8::new(PENDING));
        stop_completion(slot.clone()).call((std::ptr::null_mut(),));
        assert_eq!(slot.load(Ordering::Acquire), SUCCEEDED);
    }
}
