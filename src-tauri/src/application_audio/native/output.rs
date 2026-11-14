use super::{clock::SourceOrigin, pcm::PcmReader, StreamFault};
use crate::application_audio::handoff::{Input, Rejected, MAX_SAMPLES};
use objc2::{define_class, msg_send, rc::Retained, AnyThread, DefinedClass};
use objc2_core_media::CMSampleBuffer;
use objc2_foundation::{NSObject, NSObjectProtocol};
use objc2_screen_capture_kit::{SCStream, SCStreamOutput, SCStreamOutputType};
use std::sync::{Arc, Mutex};

struct Samples {
    pcm: PcmReader,
    input: Input,
    scratch: Box<[f32; MAX_SAMPLES]>,
}

pub(super) struct Callback {
    fault: Arc<StreamFault>,
    samples: Mutex<Samples>,
    origin: Arc<SourceOrigin>,
}

impl Callback {
    // SAFETY: native metadata/backing must be stable for this call. The mutex is
    // only tried, never waited on. Contention/reentrancy fails closed rather than
    // aliasing mutable PCM/ring state or blocking an audio callback.
    unsafe fn receive(&self, buffer: &CMSampleBuffer, kind: SCStreamOutputType) {
        if self.fault.control.is_cancelled() {
            return;
        }
        if kind != SCStreamOutputType::Audio {
            self.fault.record();
            return;
        }
        let Ok(mut state) = self.samples.try_lock() else {
            self.fault.record();
            return;
        };
        if self.fault.control.is_cancelled() {
            return;
        }
        let Samples {
            pcm,
            input,
            scratch,
        } = &mut *state;
        // SAFETY: caller's native lifetime contract; exclusive fixed scratch.
        let span = match unsafe { pcm.read(buffer, scratch) } {
            Ok(span) => span,
            Err(_) => {
                self.fault.record_code(super::AUDIO_UNREADABLE);
                return;
            }
        };
        // The PCM reader sets its origin only after validating the whole buffer.
        // Publish copied metadata before the ring packet, without consulting a clock.
        self.origin
            .publish(pcm.source_origin().expect("validated PCM origin"));
        match input.push(
            &self.fault.control,
            span.first_frame,
            &scratch[..span.frames],
        ) {
            // Full consumes its interval; a later packet preserves that gap.
            Ok(()) | Err(Rejected::Full | Rejected::Cancelled) => {}
            Err(Rejected::Closed) => self
                .fault
                .control
                .0
                .cancelled
                .store(true, std::sync::atomic::Ordering::Release),
            Err(_) => self.fault.record(),
        }
    }
}

define_class!(
    // SAFETY: NSObject has no subclass requirements. The only mutable ivars are
    // behind a non-waiting try_lock; shared fault state is atomic. No native
    // references escape the callback. Stream owns this object through queue drain.
    #[unsafe(super = NSObject)]
    #[name = "TalkQTEApplicationAudioOutput"]
    #[ivars = Callback]
    pub(super) struct AudioOutput;

    unsafe impl NSObjectProtocol for AudioOutput {}

    unsafe impl SCStreamOutput for AudioOutput {
        #[unsafe(method(stream:didOutputSampleBuffer:ofType:))]
        unsafe fn received(
            &self,
            _stream: &SCStream,
            buffer: &CMSampleBuffer,
            kind: SCStreamOutputType,
        ) {
            // SAFETY: ScreenCaptureKit supplies the borrowed buffer for this
            // callback; begin's contract requires immutable valid native data.
            unsafe { self.ivars().receive(buffer, kind) };
        }
    }
);

impl AudioOutput {
    pub(super) fn origin(&self) -> Arc<SourceOrigin> {
        self.ivars().origin.clone()
    }

    pub(super) fn new(input: Input, pcm: PcmReader, fault: Arc<StreamFault>) -> Retained<Self> {
        // All storage is created before native start, outside the audio callback.
        let this = Self::alloc().set_ivars(Callback {
            fault,
            origin: Arc::new(SourceOrigin::default()),
            samples: Mutex::new(Samples {
                pcm,
                input,
                scratch: Box::new([0.0; MAX_SAMPLES]),
            }),
        });
        // SAFETY: NSObject initialization with initialized ivars.
        unsafe { msg_send![super(this), init] }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::application_audio::{
        handoff::{Format, Reader},
        native::pcm::tests::{format, sample, time},
        timing::TimingError,
        Application, Capture, Control, Gate, Start,
    };
    use std::sync::atomic::Ordering;

    fn setup() -> (Gate, Control, Start, Retained<AudioOutput>, Reader) {
        setup_with(PcmReader::new(time(10, 1)).unwrap())
    }

    fn setup_with(pcm: PcmReader) -> (Gate, Control, Start, Retained<AudioOutput>, Reader) {
        let gate = Gate::default();
        let application =
            Application::new("fictional-player".into(), "Fictional player".into()).unwrap();
        let mut review = gate.review(application).unwrap();
        let control = review.control();
        let mut start = gate.approve(&mut review).unwrap();
        let (input, reader) = start.handoff(Format::new(16_000, 1).unwrap(), 1).unwrap();
        let output = AudioOutput::new(input, pcm, Arc::new(StreamFault::new(control.clone())));
        (gate, control, start, output, reader)
    }

    fn accept(start: Start) -> Capture<()> {
        // The synthetic gate accepts a unit resource, never a native stream.
        start.run(|_, _| Ok(())).unwrap()
    }

    fn deliver(output: &AudioOutput, frame: i64, values: &[f32]) {
        let buffer = sample(
            format(),
            values,
            time(160_000 + frame, 16_000),
            time(1, 16_000),
            true,
        );
        // SAFETY: immutable, memory-backed fictional CoreMedia buffer lives
        // through exactly the same receive function called by the output method.
        unsafe { output.ivars().receive(&buffer, SCStreamOutputType::Audio) };
    }

    #[test]
    fn first_validated_timestamp_is_published_before_packet_and_never_replaced() {
        let (_gate, control, start, output, mut reader) =
            setup_with(PcmReader::from_first_sample());
        let origin = output.origin();
        assert!(origin.get().is_none());
        let buffer = sample(
            format(),
            &[0.25; 16],
            time(10_000_001, 1_000_000),
            time(1, 16_000),
            true,
        );
        unsafe { output.ivars().receive(&buffer, SCStreamOutputType::Audio) };
        assert_eq!(
            origin.get().map(|t| (t.value, t.timescale)),
            Some((10_000_001, 1_000_000))
        );
        let _capture = accept(start);
        assert_eq!(reader.try_next().unwrap().unwrap().first_frame(), 0);
        let invalid = sample(
            format(),
            &[f32::NAN; 16],
            time(10_001_001, 1_000_000),
            time(1, 16_000),
            true,
        );
        unsafe { output.ivars().receive(&invalid, SCStreamOutputType::Audio) };
        assert!(control.is_cancelled());
        assert_eq!(
            origin.get().map(|t| (t.value, t.timescale)),
            Some((10_000_001, 1_000_000))
        );

        let (_gate, control, _start, output, _reader) = setup_with(PcmReader::from_first_sample());
        unsafe { output.ivars().receive(&invalid, SCStreamOutputType::Audio) };
        assert!(control.is_cancelled());
        assert!(output.origin().get().is_none());
    }

    #[test]
    fn native_samples_wait_for_start_and_keep_source_session_and_clock() {
        let (_gate, control, start, output, reader) = setup();
        let mut reader = reader.bind_session(7, 250);
        deliver(&output, 16, &[0.25, -2.0]);
        assert!(matches!(
            reader.try_next(7),
            Err(TimingError::Handoff(Rejected::NotReady))
        ));
        let _capture = accept(start);
        let block = reader.try_next(7).unwrap().unwrap();
        assert_eq!(block.start_ms(), 251);
        assert_eq!(block.audio().first_frame(), 16);
        assert_eq!(block.audio().samples(), &[0.25, -1.0]);
        assert!(block.belongs_to(7, &control));
        assert!(!block.belongs_to(8, &control));
    }

    #[test]
    fn full_handoff_drops_without_stalling_and_preserves_missing_time() {
        let (_gate, control, start, output, mut reader) = setup();
        let _capture = accept(start);
        deliver(&output, 0, &[0.1; 16]);
        deliver(&output, 16, &[0.2; 16]);
        assert!(!control.is_cancelled());
        assert_eq!(reader.dropped_frames(), 16);
        assert_eq!(reader.try_next().unwrap().unwrap().first_frame(), 0);
        deliver(&output, 32, &[0.3; 16]);
        let next = reader.try_next().unwrap().unwrap();
        assert_eq!(next.first_frame(), 32);
        assert_eq!(next.gap_frames(), 16);
    }

    #[test]
    fn invalid_sample_cancels_delivery_including_already_returned_audio() {
        let (_gate, control, start, output, mut reader) = setup();
        let _capture = accept(start);
        deliver(&output, 0, &[0.1]);
        let returned = reader.try_next().unwrap().unwrap();
        deliver(&output, 1, &[f32::NAN]);
        assert!(control.is_cancelled());
        assert!(output.ivars().fault.failed.load(Ordering::Acquire));
        assert!(!returned.belongs_to(&control));
        deliver(&output, 2, &[0.3]);
        assert!(matches!(reader.try_next(), Err(Rejected::Cancelled)));
    }

    #[test]
    fn stop_skips_even_invalid_native_input_without_recording_a_fault() {
        let (gate, control, start, output, mut reader) = setup();
        let _capture = accept(start);
        deliver(&output, 0, &[0.1]);
        gate.stop(&control).unwrap();
        deliver(&output, 1, &[f32::NAN]);
        assert!(!output.ivars().fault.failed.load(Ordering::Acquire));
        assert!(matches!(reader.try_next(), Err(Rejected::Cancelled)));
    }

    #[test]
    fn reentrant_callback_never_waits_or_aliases_mutable_state() {
        let (_gate, control, start, output, _reader) = setup();
        let _capture = accept(start);
        let _held = output.ivars().samples.lock().unwrap();
        deliver(&output, 0, &[0.1]);
        assert!(control.is_cancelled());
        assert!(output.ivars().fault.failed.load(Ordering::Acquire));
    }

    #[test]
    fn abandoned_session_and_wrong_output_type_close_delivery() {
        let (_gate, control, start, output, reader) = setup();
        let _capture = accept(start);
        let mut session = reader.bind_session(7, 0);
        assert!(matches!(
            session.try_next(8),
            Err(TimingError::SessionChanged)
        ));
        deliver(&output, 0, &[0.1]);
        assert!(control.is_cancelled());
        assert!(!output.ivars().fault.failed.load(Ordering::Acquire));

        let (_gate, control, start, output, _reader) = setup();
        let _capture = accept(start);
        let buffer = sample(format(), &[0.1], time(10, 1), time(1, 16_000), true);
        unsafe { output.ivars().receive(&buffer, SCStreamOutputType::Screen) };
        assert!(control.is_cancelled());
        assert!(output.ivars().fault.failed.load(Ordering::Acquire));
    }
}
