//! macOS hardware/OS Acoustic Echo Cancellation (AEC) microphone adapter using
//! Apple's `VoiceProcessingIO` AudioUnit (`kAudioUnitSubType_VoiceProcessingIO`).
//!
//! Real-time audio rule: the AudioUnit input callback never allocates, locks,
//! blocks, logs, or performs I/O. It pulls processed PCM frames via
//! `AudioUnitRender` into a pre-allocated 16-byte-aligned scratch buffer,
//! updates the atomic activity `Meter`, and pushes mono `f32` samples into a
//! bounded lock-free `rtrb` ring buffer (`audio_tap::TapInput`).
//! `audio_tap::Chunker` drains and resamples the ring to the 16 kHz mono PCM
//! chunks expected by transcription. If `VoiceProcessingIO` cannot initialize on
//! a device or configuration, capture falls back calmly to `cpal`.

use crate::{
    audio_tap::{Chunker, TapInput},
    microphone::{CaptureStream, Failure, Meter},
};
use objc2_core_audio_types::{
    kAudioFormatFlagIsBigEndian, kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved,
    kAudioFormatFlagIsPacked, kAudioFormatFlagIsSignedInteger, kAudioFormatLinearPCM,
    AudioStreamBasicDescription,
};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

/// Preferred sample rate requested from VoiceProcessingIO's built-in converter.
const PREFERRED_SAMPLE_RATE: f64 = 16_000.0;
const FALLBACK_SAMPLE_RATE: f64 = 48_000.0;
const MIN_SAMPLE_RATE: f64 = 8_000.0;
const MAX_SAMPLE_RATE: f64 = 384_000.0;
const MAX_CHANNELS: usize = 16;
const DEFAULT_MAX_FRAMES: usize = 4_096;
const MIN_SCRATCH_FRAMES: usize = 8_192;
/// Consecutive `AudioUnitRender` failures before flagging device failure.
const MAX_CONSECUTIVE_RENDER_ERRORS: u32 = 16;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) enum SampleEncoding {
    Float32,
    SignedInt16,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub(crate) struct ValidatedFormat {
    pub sample_rate: u32,
    pub channels: usize,
    pub is_non_interleaved: bool,
    pub encoding: SampleEncoding,
}

/// 16-byte-aligned block for the pre-allocated `AudioUnitRender` scratch buffer.
#[repr(C, align(16))]
#[derive(Clone, Copy, Default)]
pub(crate) struct AlignedBlock(pub [u8; 16]);

/// Raw PCM buffer descriptor passed from CoreAudio's `AudioBufferList` into the
/// allocation-free ring/meter ingest path.
#[derive(Clone, Copy)]
pub(crate) struct RawPcmBuffer {
    pub channels: u32,
    pub data: *const u8,
    pub bytes: usize,
}

impl Default for RawPcmBuffer {
    fn default() -> Self {
        Self {
            channels: 0,
            data: std::ptr::null(),
            bytes: 0,
        }
    }
}

/// Builds the canonical 16-byte-aligned scratch storage sized for `frames`
/// frames across `channels` channels of `encoding`.
pub(crate) fn alloc_scratch(
    frames: usize,
    channels: usize,
    encoding: SampleEncoding,
) -> Box<[AlignedBlock]> {
    let bytes_per_sample = match encoding {
        SampleEncoding::Float32 => 4,
        SampleEncoding::SignedInt16 => 2,
    };
    let total_bytes = frames
        .max(1)
        .saturating_mul(channels.max(1))
        .saturating_mul(bytes_per_sample);
    let blocks = total_bytes.div_ceil(std::mem::size_of::<AlignedBlock>());
    vec![AlignedBlock::default(); blocks].into_boxed_slice()
}

/// Constructs an Apple `AudioStreamBasicDescription` for mono linear PCM `f32`.
pub(crate) fn mono_f32_asbd(sample_rate: f64) -> AudioStreamBasicDescription {
    AudioStreamBasicDescription {
        mSampleRate: sample_rate,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked,
        mBytesPerPacket: 4,
        mFramesPerPacket: 1,
        mBytesPerFrame: 4,
        mChannelsPerFrame: 1,
        mBitsPerChannel: 32,
        mReserved: 0,
    }
}

/// Adjusts an existing ASBD to native-endian `f32` at `sample_rate` while
/// preserving its channel count and interleaved/planar layout when valid.
pub(crate) fn f32_asbd_for_rate(
    existing: &AudioStreamBasicDescription,
    sample_rate: f64,
) -> AudioStreamBasicDescription {
    let channels = existing.mChannelsPerFrame.clamp(1, MAX_CHANNELS as u32);
    let non_interleaved =
        (existing.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0 && channels > 1;
    let bytes_per_frame = if non_interleaved { 4 } else { 4 * channels };
    let flags = kAudioFormatFlagIsFloat
        | kAudioFormatFlagIsPacked
        | if non_interleaved {
            kAudioFormatFlagIsNonInterleaved
        } else {
            0
        };
    AudioStreamBasicDescription {
        mSampleRate: sample_rate,
        mFormatID: kAudioFormatLinearPCM,
        mFormatFlags: flags,
        mBytesPerPacket: bytes_per_frame,
        mFramesPerPacket: 1,
        mBytesPerFrame: bytes_per_frame,
        mChannelsPerFrame: channels,
        mBitsPerChannel: 32,
        mReserved: 0,
    }
}

/// Validates an ASBD returned by `VoiceProcessingIO`.
pub(crate) fn validate_asbd(
    asbd: &AudioStreamBasicDescription,
) -> Result<ValidatedFormat, Failure> {
    if asbd.mFormatID != kAudioFormatLinearPCM
        || (asbd.mFormatFlags & kAudioFormatFlagIsBigEndian) != 0
        || !asbd.mSampleRate.is_finite()
        || asbd.mSampleRate < MIN_SAMPLE_RATE
        || asbd.mSampleRate > MAX_SAMPLE_RATE
        || asbd.mChannelsPerFrame == 0
        || asbd.mChannelsPerFrame as usize > MAX_CHANNELS
    {
        return Err(Failure::Unsupported);
    }

    let encoding =
        if (asbd.mFormatFlags & kAudioFormatFlagIsFloat) != 0 && asbd.mBitsPerChannel == 32 {
            SampleEncoding::Float32
        } else if (asbd.mFormatFlags & kAudioFormatFlagIsSignedInteger) != 0
            && asbd.mBitsPerChannel == 16
        {
            SampleEncoding::SignedInt16
        } else {
            return Err(Failure::Unsupported);
        };

    Ok(ValidatedFormat {
        sample_rate: asbd.mSampleRate.round() as u32,
        channels: asbd.mChannelsPerFrame as usize,
        is_non_interleaved: (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0,
        encoding,
    })
}

#[inline]
unsafe fn read_pcm_sample(data: *const u8, index: usize, encoding: SampleEncoding) -> f32 {
    match encoding {
        SampleEncoding::Float32 => {
            // SAFETY: caller ensures `data` is readable for `(index + 1) * 4` bytes.
            let bytes = unsafe { *(data.add(index * 4) as *const [u8; 4]) };
            let sample = f32::from_ne_bytes(bytes);
            if sample.is_finite() {
                sample
            } else {
                0.0
            }
        }
        SampleEncoding::SignedInt16 => {
            // SAFETY: caller ensures `data` is readable for `(index + 1) * 2` bytes.
            let bytes = unsafe { *(data.add(index * 2) as *const [u8; 2]) };
            let raw = i16::from_ne_bytes(bytes);
            f32::from(raw) / 32_768.0
        }
    }
}

/// Downmixes rendered PCM buffers into mono `f32`, updates `meter`, and pushes
/// samples into the lock-free `rtrb` ring (`tap`), with zero heap allocations
/// or locks.
///
/// # Safety
/// For every `buf` in `buffers` with non-null `data` and `bytes > 0`, `data`
/// must remain readable for at least `bytes` bytes for the duration of this call.
pub(crate) unsafe fn ingest_pcm_buffers(
    meter: &Meter,
    tap_input: Option<&mut TapInput>,
    buffers: &[RawPcmBuffer],
    frames: usize,
    format: ValidatedFormat,
    is_silence: bool,
) {
    if frames == 0 {
        return;
    }

    if is_silence {
        meter.observe(std::iter::repeat_n(0.0, frames));
        if let Some(tap) = tap_input {
            for _ in 0..frames {
                tap.push_mono(0.0);
            }
        }
        return;
    }

    let sample_bytes = match format.encoding {
        SampleEncoding::Float32 => 4,
        SampleEncoding::SignedInt16 => 2,
    };

    if format.is_non_interleaved && buffers.len() > 1 {
        let mut active_channels = 0usize;
        let mut available_frames = frames;
        for buf in buffers {
            if !buf.data.is_null() && buf.bytes >= sample_bytes {
                active_channels += 1;
                available_frames = available_frames.min(buf.bytes / sample_bytes);
            }
        }
        if active_channels == 0 || available_frames == 0 {
            return;
        }
        let scale = 1.0 / active_channels as f32;
        let sample_at = |frame: usize| -> f32 {
            let mut sum = 0.0f32;
            for buf in buffers {
                if !buf.data.is_null() && buf.bytes >= (frame + 1) * sample_bytes {
                    sum += unsafe { read_pcm_sample(buf.data, frame, format.encoding) };
                }
            }
            sum * scale
        };
        meter.observe((0..available_frames).map(sample_at));
        if let Some(tap) = tap_input {
            for frame in 0..available_frames {
                tap.push_mono(sample_at(frame));
            }
        }
        return;
    }

    let Some(buf) = buffers.first() else {
        return;
    };
    if buf.data.is_null() || buf.bytes < sample_bytes {
        return;
    }
    let ch = (buf.channels as usize).max(format.channels).max(1);
    let available_frames = frames.min((buf.bytes / sample_bytes) / ch);
    if available_frames == 0 {
        return;
    }
    let scale = 1.0 / ch as f32;
    let sample_at = |frame: usize| -> f32 {
        let base = frame * ch;
        let mut sum = 0.0f32;
        for c in 0..ch {
            sum += unsafe { read_pcm_sample(buf.data, base + c, format.encoding) };
        }
        sum * scale
    };
    meter.observe((0..available_frames).map(sample_at));
    if let Some(tap) = tap_input {
        for frame in 0..available_frames {
            tap.push_mono(sample_at(frame));
        }
    }
}

/// Callback state shared with the AudioUnit input callback. Created before
/// `AudioOutputUnitStart` and freed only after `AudioOutputUnitStop`,
/// `AudioUnitUninitialize`, and `AudioComponentInstanceDispose` have completed.
pub(crate) struct CallbackContext {
    unit: *mut std::ffi::c_void,
    format: ValidatedFormat,
    meter: Arc<Meter>,
    tap: Option<TapInput>,
    scratch: Box<[AlignedBlock]>,
    stopped: AtomicBool,
    consecutive_errors: u32,
}

impl CallbackContext {
    fn new(unit: *mut std::ffi::c_void, meter: Arc<Meter>, format: ValidatedFormat) -> Self {
        Self {
            unit,
            format,
            meter,
            tap: None,
            scratch: Box::new([]),
            stopped: AtomicBool::new(false),
            consecutive_errors: 0,
        }
    }

    fn scratch_bytes(&self) -> usize {
        self.scratch.len() * std::mem::size_of::<AlignedBlock>()
    }

    fn scratch_mut_ptr(&mut self) -> *mut u8 {
        self.scratch.as_mut_ptr().cast::<u8>()
    }
}

/// Abstract lifecycle operations for an initialized AudioUnit so teardown order
/// and failure paths can be unit-tested offline without touching CoreAudio.
pub(crate) trait VoiceUnitOps: Send + Sync {
    fn start(&self) -> i32;
    fn stop(&self) -> i32;
    fn uninitialize(&self) -> i32;
    fn dispose(&mut self) -> i32;
}

/// Managed `VoiceProcessingIO` capture stream. Ensures clean teardown
/// (`AudioOutputUnitStop` -> `AudioUnitUninitialize` ->
/// `AudioComponentInstanceDispose`) before releasing callback storage.
pub(crate) struct VoiceProcessingStream<U: VoiceUnitOps> {
    unit: U,
    device_name: Option<String>,
    started: AtomicBool,
    initialized: bool,
    ctx_ptr: *mut CallbackContext,
    torn_down: bool,
}

// SAFETY: `VoiceProcessingStream` synchronizes `started` atomically and only
// frees `ctx_ptr` in `Drop` after stopping and disposing the AudioUnit.
unsafe impl<U: VoiceUnitOps> Send for VoiceProcessingStream<U> {}
unsafe impl<U: VoiceUnitOps> Sync for VoiceProcessingStream<U> {}

impl<U: VoiceUnitOps> VoiceProcessingStream<U> {
    fn new(unit: U, device_name: Option<String>, ctx_ptr: *mut CallbackContext) -> Self {
        Self {
            unit,
            device_name,
            started: AtomicBool::new(false),
            initialized: false,
            ctx_ptr,
            torn_down: false,
        }
    }

    fn teardown(&mut self) {
        if self.torn_down {
            return;
        }
        self.torn_down = true;
        if !self.ctx_ptr.is_null() {
            // SAFETY: `ctx_ptr` remains valid until after `dispose()` returns.
            unsafe { (*self.ctx_ptr).stopped.store(true, Ordering::Release) };
        }
        if self.started.swap(false, Ordering::AcqRel) {
            let _ = self.unit.stop();
        }
        if self.initialized {
            self.initialized = false;
            let _ = self.unit.uninitialize();
        }
        let _ = self.unit.dispose();
        if !self.ctx_ptr.is_null() {
            // SAFETY: AudioUnit is stopped and disposed, so no callback can run.
            drop(unsafe { Box::from_raw(self.ctx_ptr) });
            self.ctx_ptr = std::ptr::null_mut();
        }
    }
}

impl<U: VoiceUnitOps> CaptureStream for VoiceProcessingStream<U> {
    fn play(&self) -> Result<(), Failure> {
        let status = self.unit.start();
        if status == 0 {
            self.started.store(true, Ordering::Release);
            Ok(())
        } else {
            Err(Failure::Device)
        }
    }

    fn device_name(&self) -> Option<&str> {
        self.device_name.as_deref()
    }
}

impl<U: VoiceUnitOps> Drop for VoiceProcessingStream<U> {
    fn drop(&mut self) {
        self.teardown();
    }
}

/// Attempts to build a `VoiceProcessingIO` AEC stream first, and calmly falls
/// back to `open_cpal` if `VoiceProcessingIO` fails to initialize on this
/// device or configuration.
pub(crate) fn build_stream_with_fallback<A, C>(
    meter: Arc<Meter>,
    tap_chunk_ms: Option<u64>,
    open_aec: A,
    open_cpal: C,
) -> Result<(Box<dyn CaptureStream>, Option<Chunker>), Failure>
where
    A: FnOnce(
        Arc<Meter>,
        Option<u64>,
    ) -> Result<(Box<dyn CaptureStream>, Option<Chunker>), Failure>,
    C: FnOnce(
        Arc<Meter>,
        Option<u64>,
    ) -> Result<(Box<dyn CaptureStream>, Option<Chunker>), Failure>,
{
    match open_aec(meter.clone(), tap_chunk_ms) {
        Ok(stream) => Ok(stream),
        Err(_) => open_cpal(meter, tap_chunk_ms),
    }
}

/// Opens a macOS microphone capture stream with Apple `VoiceProcessingIO`
/// Acoustic Echo Cancellation enabled, falling back calmly to `open_cpal` if
/// `VoiceProcessingIO` fails to initialize.
pub(crate) fn build_stream(
    meter: Arc<Meter>,
    tap_chunk_ms: Option<u64>,
    open_cpal: impl FnOnce(
        Arc<Meter>,
        Option<u64>,
    ) -> Result<(Box<dyn CaptureStream>, Option<Chunker>), Failure>,
) -> Result<(Box<dyn CaptureStream>, Option<Chunker>), Failure> {
    build_stream_with_fallback(meter, tap_chunk_ms, native::open, open_cpal)
}

mod native {
    use super::{
        alloc_scratch, f32_asbd_for_rate, ingest_pcm_buffers, mono_f32_asbd, validate_asbd,
        CallbackContext, RawPcmBuffer, SampleEncoding, ValidatedFormat, VoiceProcessingStream,
        VoiceUnitOps, DEFAULT_MAX_FRAMES, FALLBACK_SAMPLE_RATE, MAX_CHANNELS,
        MAX_CONSECUTIVE_RENDER_ERRORS, MAX_SAMPLE_RATE, MIN_SAMPLE_RATE, MIN_SCRATCH_FRAMES,
        PREFERRED_SAMPLE_RATE,
    };
    use crate::{
        audio_tap::tap,
        microphone::{CaptureStream, Failure, Meter},
    };
    use objc2_core_audio_types::{
        AudioBuffer, AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp,
    };
    use std::ffi::c_void;
    use std::sync::atomic::Ordering;
    use std::sync::Arc;

    type AudioUnit = *mut c_void;
    type AudioComponent = *mut c_void;
    type AudioUnitRenderActionFlags = u32;
    type CFStringRef = *const c_void;

    const K_AUDIO_UNIT_TYPE_OUTPUT: u32 = u32::from_be_bytes(*b"auou");
    const K_AUDIO_UNIT_SUBTYPE_VOICE_PROCESSING_IO: u32 = u32::from_be_bytes(*b"vpio");
    const K_AUDIO_UNIT_MANUFACTURER_APPLE: u32 = u32::from_be_bytes(*b"appl");

    const K_AUDIO_UNIT_SCOPE_GLOBAL: u32 = 0;
    const K_AUDIO_UNIT_SCOPE_INPUT: u32 = 1;
    const K_AUDIO_UNIT_SCOPE_OUTPUT: u32 = 2;

    const K_OUTPUT_BUS: u32 = 0;
    const K_INPUT_BUS: u32 = 1;

    const K_AUDIO_UNIT_PROPERTY_STREAM_FORMAT: u32 = 8;
    const K_AUDIO_UNIT_PROPERTY_MAXIMUM_FRAMES_PER_SLICE: u32 = 14;
    const K_AUDIO_UNIT_PROPERTY_SET_RENDER_CALLBACK: u32 = 23;
    const K_AUDIO_OUTPUT_UNIT_PROPERTY_ENABLE_IO: u32 = 2003;
    const K_AUDIO_OUTPUT_UNIT_PROPERTY_SET_INPUT_CALLBACK: u32 = 2005;
    const K_AUDIO_OUTPUT_UNIT_PROPERTY_HAS_IO: u32 = 2006;

    const K_AU_VOICE_IO_PROPERTY_BYPASS_VOICE_PROCESSING: u32 = 2100;
    const K_AU_VOICE_IO_PROPERTY_VOICE_PROCESSING_ENABLE_AGC: u32 = 2101;
    const K_AU_VOICE_IO_PROPERTY_MUTE_OUTPUT: u32 = 2104;
    const K_AU_VOICE_IO_PROPERTY_OTHER_AUDIO_DUCKING_CONFIGURATION: u32 = 2108;
    const K_AU_VOICE_IO_OTHER_AUDIO_DUCKING_LEVEL_MIN: u32 = 10;

    const K_AUDIO_UNIT_RENDER_ACTION_OUTPUT_IS_SILENCE: u32 = 1 << 4;

    const K_AUDIO_OBJECT_SYSTEM_OBJECT: u32 = 1;
    const K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL: u32 = u32::from_be_bytes(*b"glob");
    const K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN: u32 = 0;
    const K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE: u32 = u32::from_be_bytes(*b"dIn ");
    const K_AUDIO_OBJECT_PROPERTY_NAME: u32 = u32::from_be_bytes(*b"lnam");
    const K_CF_STRING_ENCODING_UTF8: u32 = 0x0800_0100;

    #[repr(C)]
    struct AudioComponentDescription {
        component_type: u32,
        component_sub_type: u32,
        component_manufacturer: u32,
        component_flags: u32,
        component_flags_mask: u32,
    }

    type AURenderCallback = unsafe extern "C" fn(
        in_ref_con: *mut c_void,
        io_action_flags: *mut AudioUnitRenderActionFlags,
        in_time_stamp: *const AudioTimeStamp,
        in_bus_number: u32,
        in_number_frames: u32,
        io_data: *mut AudioBufferList,
    ) -> i32;

    #[repr(C)]
    struct AURenderCallbackStruct {
        input_proc: Option<AURenderCallback>,
        input_proc_ref_con: *mut c_void,
    }

    #[repr(C)]
    struct AUVoiceIOOtherAudioDuckingConfiguration {
        enable_advanced_ducking: u8,
        ducking_level: u32,
    }

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    #[repr(C)]
    struct MultiAudioBufferList<const N: usize> {
        number_buffers: u32,
        buffers: [AudioBuffer; N],
    }

    #[link(name = "AudioToolbox", kind = "framework")]
    extern "C" {
        fn AudioComponentFindNext(
            in_component: AudioComponent,
            in_desc: *const AudioComponentDescription,
        ) -> AudioComponent;

        fn AudioComponentInstanceNew(
            in_component: AudioComponent,
            out_instance: *mut AudioUnit,
        ) -> i32;

        fn AudioComponentInstanceDispose(in_instance: AudioUnit) -> i32;

        fn AudioUnitInitialize(in_unit: AudioUnit) -> i32;

        fn AudioUnitUninitialize(in_unit: AudioUnit) -> i32;

        fn AudioUnitGetProperty(
            in_unit: AudioUnit,
            in_id: u32,
            in_scope: u32,
            in_element: u32,
            out_data: *mut c_void,
            io_data_size: *mut u32,
        ) -> i32;

        fn AudioUnitSetProperty(
            in_unit: AudioUnit,
            in_id: u32,
            in_scope: u32,
            in_element: u32,
            in_data: *const c_void,
            in_data_size: u32,
        ) -> i32;

        fn AudioUnitRender(
            in_unit: AudioUnit,
            io_action_flags: *mut AudioUnitRenderActionFlags,
            in_time_stamp: *const AudioTimeStamp,
            in_output_bus_number: u32,
            in_number_frames: u32,
            io_data: *mut AudioBufferList,
        ) -> i32;

        fn AudioOutputUnitStart(ci: AudioUnit) -> i32;

        fn AudioOutputUnitStop(ci: AudioUnit) -> i32;
    }

    #[link(name = "CoreAudio", kind = "framework")]
    extern "C" {
        fn AudioObjectGetPropertyData(
            object: u32,
            address: *const AudioObjectPropertyAddress,
            qualifier_size: u32,
            qualifier: *const c_void,
            data_size: *mut u32,
            data: *mut c_void,
        ) -> i32;
    }

    #[link(name = "CoreFoundation", kind = "framework")]
    extern "C" {
        fn CFStringGetLength(the_string: CFStringRef) -> isize;
        fn CFStringGetMaximumSizeForEncoding(length: isize, encoding: u32) -> isize;
        fn CFStringGetCString(
            the_string: CFStringRef,
            buffer: *mut std::ffi::c_char,
            buffer_size: isize,
            encoding: u32,
        ) -> u8;
        fn CFRelease(cf: *const c_void);
    }

    pub(crate) struct NativeVoiceUnit {
        unit: AudioUnit,
    }

    // SAFETY: NativeVoiceUnit wraps an Apple AudioComponentInstance handle whose
    // start/stop/uninitialize/dispose calls are serialized by `Controller`.
    unsafe impl Send for NativeVoiceUnit {}
    unsafe impl Sync for NativeVoiceUnit {}

    impl VoiceUnitOps for NativeVoiceUnit {
        fn start(&self) -> i32 {
            if self.unit.is_null() {
                return -50;
            }
            unsafe { AudioOutputUnitStart(self.unit) }
        }

        fn stop(&self) -> i32 {
            if self.unit.is_null() {
                return 0;
            }
            unsafe { AudioOutputUnitStop(self.unit) }
        }

        fn uninitialize(&self) -> i32 {
            if self.unit.is_null() {
                return 0;
            }
            unsafe { AudioUnitUninitialize(self.unit) }
        }

        fn dispose(&mut self) -> i32 {
            if self.unit.is_null() {
                return 0;
            }
            let unit = self.unit;
            self.unit = std::ptr::null_mut();
            unsafe { AudioComponentInstanceDispose(unit) }
        }
    }

    fn default_input_device_info() -> Result<(u32, Option<String>), Failure> {
        let addr = AudioObjectPropertyAddress {
            selector: K_AUDIO_HARDWARE_PROPERTY_DEFAULT_INPUT_DEVICE,
            scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        };
        let mut device_id: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                K_AUDIO_OBJECT_SYSTEM_OBJECT,
                &addr,
                0,
                std::ptr::null(),
                &mut size,
                (&mut device_id as *mut u32).cast(),
            )
        };
        if status != 0 || device_id == 0 {
            return Err(Failure::NoDevice);
        }

        let name_addr = AudioObjectPropertyAddress {
            selector: K_AUDIO_OBJECT_PROPERTY_NAME,
            scope: K_AUDIO_OBJECT_PROPERTY_SCOPE_GLOBAL,
            element: K_AUDIO_OBJECT_PROPERTY_ELEMENT_MAIN,
        };
        let mut cf_name: CFStringRef = std::ptr::null();
        let mut name_size = std::mem::size_of::<CFStringRef>() as u32;
        let name_status = unsafe {
            AudioObjectGetPropertyData(
                device_id,
                &name_addr,
                0,
                std::ptr::null(),
                &mut name_size,
                (&mut cf_name as *mut CFStringRef).cast(),
            )
        };
        let name = if name_status == 0 && !cf_name.is_null() {
            let extracted = cfstring_to_string(cf_name);
            unsafe { CFRelease(cf_name) };
            extracted
        } else {
            None
        };
        Ok((device_id, name))
    }

    fn cfstring_to_string(cf_str: CFStringRef) -> Option<String> {
        if cf_str.is_null() {
            return None;
        }
        unsafe {
            let len = CFStringGetLength(cf_str);
            if len <= 0 {
                return None;
            }
            let max_bytes = CFStringGetMaximumSizeForEncoding(len, K_CF_STRING_ENCODING_UTF8) + 1;
            if max_bytes <= 1 {
                return None;
            }
            let mut buf = vec![0u8; max_bytes as usize];
            if CFStringGetCString(
                cf_str,
                buf.as_mut_ptr().cast(),
                max_bytes,
                K_CF_STRING_ENCODING_UTF8,
            ) == 0
            {
                return None;
            }
            let end = buf.iter().position(|&b| b == 0).unwrap_or(buf.len());
            String::from_utf8(buf[..end].to_vec()).ok()
        }
    }

    unsafe fn set_u32_property(
        unit: AudioUnit,
        id: u32,
        scope: u32,
        element: u32,
        value: u32,
    ) -> i32 {
        unsafe {
            AudioUnitSetProperty(
                unit,
                id,
                scope,
                element,
                (&value as *const u32).cast(),
                std::mem::size_of::<u32>() as u32,
            )
        }
    }

    unsafe fn get_u32_property(unit: AudioUnit, id: u32, scope: u32, element: u32) -> Option<u32> {
        let mut value: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            AudioUnitGetProperty(
                unit,
                id,
                scope,
                element,
                (&mut value as *mut u32).cast(),
                &mut size,
            )
        };
        (status == 0 && size as usize == std::mem::size_of::<u32>()).then_some(value)
    }

    unsafe fn get_asbd(
        unit: AudioUnit,
        scope: u32,
        element: u32,
    ) -> Option<AudioStreamBasicDescription> {
        let mut asbd: AudioStreamBasicDescription = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
        let status = unsafe {
            AudioUnitGetProperty(
                unit,
                K_AUDIO_UNIT_PROPERTY_STREAM_FORMAT,
                scope,
                element,
                (&mut asbd as *mut AudioStreamBasicDescription).cast(),
                &mut size,
            )
        };
        (status == 0 && size as usize == std::mem::size_of::<AudioStreamBasicDescription>())
            .then_some(asbd)
    }

    unsafe fn set_asbd(
        unit: AudioUnit,
        scope: u32,
        element: u32,
        asbd: &AudioStreamBasicDescription,
    ) -> i32 {
        unsafe {
            AudioUnitSetProperty(
                unit,
                K_AUDIO_UNIT_PROPERTY_STREAM_FORMAT,
                scope,
                element,
                (asbd as *const AudioStreamBasicDescription).cast(),
                std::mem::size_of::<AudioStreamBasicDescription>() as u32,
            )
        }
    }

    unsafe extern "C" fn silent_output_callback(
        _in_ref_con: *mut c_void,
        io_action_flags: *mut AudioUnitRenderActionFlags,
        _in_time_stamp: *const AudioTimeStamp,
        _in_bus_number: u32,
        _in_number_frames: u32,
        io_data: *mut AudioBufferList,
    ) -> i32 {
        if !io_action_flags.is_null() {
            unsafe {
                *io_action_flags |= K_AUDIO_UNIT_RENDER_ACTION_OUTPUT_IS_SILENCE;
            }
        }
        if !io_data.is_null() {
            let list = unsafe { &mut *io_data };
            let count = list.mNumberBuffers as usize;
            let buffers =
                unsafe { std::slice::from_raw_parts_mut(list.mBuffers.as_mut_ptr(), count) };
            for buf in buffers {
                if !buf.mData.is_null() && buf.mDataByteSize > 0 {
                    unsafe {
                        std::ptr::write_bytes(buf.mData, 0, buf.mDataByteSize as usize);
                    }
                }
            }
        }
        0
    }

    unsafe extern "C" fn input_callback(
        in_ref_con: *mut c_void,
        io_action_flags: *mut AudioUnitRenderActionFlags,
        in_time_stamp: *const AudioTimeStamp,
        in_bus_number: u32,
        in_number_frames: u32,
        _io_data: *mut AudioBufferList,
    ) -> i32 {
        if in_ref_con.is_null() || in_time_stamp.is_null() {
            return 0;
        }
        // SAFETY: `in_ref_con` remains alive until after `AudioOutputUnitStop`,
        // `AudioUnitUninitialize`, and `AudioComponentInstanceDispose` return.
        let ctx = unsafe { &mut *(in_ref_con as *mut CallbackContext) };
        if ctx.stopped.load(Ordering::Acquire) || in_number_frames == 0 {
            return 0;
        }

        let frames = in_number_frames as usize;
        let sample_bytes = match ctx.format.encoding {
            SampleEncoding::Float32 => 4,
            SampleEncoding::SignedInt16 => 2,
        };
        let total_bytes_needed = frames
            .saturating_mul(ctx.format.channels)
            .saturating_mul(sample_bytes);
        if total_bytes_needed > ctx.scratch_bytes() {
            return -50;
        }

        let mut flags = if io_action_flags.is_null() {
            0
        } else {
            unsafe { *io_action_flags }
        };
        let flags_ptr = if io_action_flags.is_null() {
            &mut flags as *mut u32
        } else {
            io_action_flags
        };

        let status = if ctx.format.is_non_interleaved && ctx.format.channels > 1 {
            let ch = ctx.format.channels.min(MAX_CHANNELS);
            let plane_bytes = (frames * sample_bytes) as u32;
            let mut list = MultiAudioBufferList::<MAX_CHANNELS> {
                number_buffers: ch as u32,
                buffers: [AudioBuffer {
                    mNumberChannels: 1,
                    mDataByteSize: 0,
                    mData: std::ptr::null_mut(),
                }; MAX_CHANNELS],
            };
            let base_ptr = ctx.scratch_mut_ptr();
            for (idx, buf) in list.buffers[..ch].iter_mut().enumerate() {
                buf.mNumberChannels = 1;
                buf.mDataByteSize = plane_bytes;
                buf.mData = unsafe { base_ptr.add(idx * frames * sample_bytes) }.cast();
            }
            unsafe {
                AudioUnitRender(
                    ctx.unit,
                    flags_ptr,
                    in_time_stamp,
                    in_bus_number,
                    in_number_frames,
                    (&mut list as *mut MultiAudioBufferList<MAX_CHANNELS>).cast(),
                )
            }
        } else {
            let byte_size = total_bytes_needed as u32;
            let mut list = AudioBufferList {
                mNumberBuffers: 1,
                mBuffers: [AudioBuffer {
                    mNumberChannels: ctx.format.channels as u32,
                    mDataByteSize: byte_size,
                    mData: ctx.scratch_mut_ptr().cast(),
                }],
            };
            unsafe {
                AudioUnitRender(
                    ctx.unit,
                    flags_ptr,
                    in_time_stamp,
                    in_bus_number,
                    in_number_frames,
                    &mut list,
                )
            }
        };

        if status != 0 {
            ctx.consecutive_errors = ctx.consecutive_errors.saturating_add(1);
            if ctx.consecutive_errors >= MAX_CONSECUTIVE_RENDER_ERRORS {
                ctx.meter.failed.store(true, Ordering::Release);
            }
            return status;
        }
        ctx.consecutive_errors = 0;

        let active_flags = unsafe { *flags_ptr };
        let is_silence = (active_flags & K_AUDIO_UNIT_RENDER_ACTION_OUTPUT_IS_SILENCE) != 0;

        let mut raw = [RawPcmBuffer::default(); MAX_CHANNELS];
        let buf_count = if ctx.format.is_non_interleaved && ctx.format.channels > 1 {
            let ch = ctx.format.channels.min(MAX_CHANNELS);
            let plane_bytes = frames * sample_bytes;
            let base_ptr = ctx.scratch_mut_ptr() as *const u8;
            for (idx, slot) in raw[..ch].iter_mut().enumerate() {
                slot.channels = 1;
                slot.data = unsafe { base_ptr.add(idx * plane_bytes) };
                slot.bytes = plane_bytes;
            }
            ch
        } else {
            raw[0] = RawPcmBuffer {
                channels: ctx.format.channels as u32,
                data: ctx.scratch_mut_ptr() as *const u8,
                bytes: total_bytes_needed,
            };
            1
        };

        unsafe {
            ingest_pcm_buffers(
                &ctx.meter,
                ctx.tap.as_mut(),
                &raw[..buf_count],
                frames,
                ctx.format,
                is_silence,
            );
        }
        0
    }

    pub(crate) fn open(
        meter: Arc<Meter>,
        tap_chunk_ms: Option<u64>,
    ) -> Result<(Box<dyn CaptureStream>, Option<crate::audio_tap::Chunker>), Failure> {
        let (_device_id, device_name) = default_input_device_info()?;

        let desc = AudioComponentDescription {
            component_type: K_AUDIO_UNIT_TYPE_OUTPUT,
            component_sub_type: K_AUDIO_UNIT_SUBTYPE_VOICE_PROCESSING_IO,
            component_manufacturer: K_AUDIO_UNIT_MANUFACTURER_APPLE,
            component_flags: 0,
            component_flags_mask: 0,
        };
        let component = unsafe { AudioComponentFindNext(std::ptr::null_mut(), &desc) };
        if component.is_null() {
            return Err(Failure::Unsupported);
        }

        let mut unit: AudioUnit = std::ptr::null_mut();
        let status = unsafe { AudioComponentInstanceNew(component, &mut unit) };
        if status != 0 || unit.is_null() {
            return Err(Failure::Device);
        }

        let placeholder_format = ValidatedFormat {
            sample_rate: FALLBACK_SAMPLE_RATE as u32,
            channels: 1,
            is_non_interleaved: false,
            encoding: SampleEncoding::Float32,
        };
        let ctx_ptr = Box::into_raw(Box::new(CallbackContext::new(
            unit,
            meter,
            placeholder_format,
        )));

        // Guard owns `unit` and `ctx_ptr` so any early error cleans up cleanly.
        let mut guard = VoiceProcessingStream::new(NativeVoiceUnit { unit }, device_name, ctx_ptr);

        unsafe {
            if set_u32_property(
                unit,
                K_AUDIO_OUTPUT_UNIT_PROPERTY_ENABLE_IO,
                K_AUDIO_UNIT_SCOPE_INPUT,
                K_INPUT_BUS,
                1,
            ) != 0
            {
                return Err(Failure::Device);
            }

            let has_input = get_u32_property(
                unit,
                K_AUDIO_OUTPUT_UNIT_PROPERTY_HAS_IO,
                K_AUDIO_UNIT_SCOPE_INPUT,
                K_INPUT_BUS,
            )
            .unwrap_or(0);
            if has_input == 0 {
                return Err(Failure::NoDevice);
            }

            // Ensure hardware/OS AEC is active and uplink is unmuted.
            if set_u32_property(
                unit,
                K_AU_VOICE_IO_PROPERTY_BYPASS_VOICE_PROCESSING,
                K_AUDIO_UNIT_SCOPE_GLOBAL,
                0,
                0,
            ) != 0
            {
                return Err(Failure::Device);
            }
            let _ = set_u32_property(
                unit,
                K_AU_VOICE_IO_PROPERTY_MUTE_OUTPUT,
                K_AUDIO_UNIT_SCOPE_GLOBAL,
                0,
                0,
            );
            let _ = set_u32_property(
                unit,
                K_AU_VOICE_IO_PROPERTY_VOICE_PROCESSING_ENABLE_AGC,
                K_AUDIO_UNIT_SCOPE_GLOBAL,
                0,
                1,
            );

            // Minimize ducking of other call audio on macOS 14+.
            let ducking = AUVoiceIOOtherAudioDuckingConfiguration {
                enable_advanced_ducking: 0,
                ducking_level: K_AU_VOICE_IO_OTHER_AUDIO_DUCKING_LEVEL_MIN,
            };
            let _ = AudioUnitSetProperty(
                unit,
                K_AU_VOICE_IO_PROPERTY_OTHER_AUDIO_DUCKING_CONFIGURATION,
                K_AUDIO_UNIT_SCOPE_GLOBAL,
                0,
                (&ducking as *const AUVoiceIOOtherAudioDuckingConfiguration).cast(),
                std::mem::size_of::<AUVoiceIOOtherAudioDuckingConfiguration>() as u32,
            );

            let orig_in_asbd = get_asbd(unit, K_AUDIO_UNIT_SCOPE_OUTPUT, K_INPUT_BUS);
            let orig_out_asbd = get_asbd(unit, K_AUDIO_UNIT_SCOPE_INPUT, K_OUTPUT_BUS);
            let default_rate = orig_in_asbd
                .as_ref()
                .map(|a| a.mSampleRate)
                .filter(|r| r.is_finite() && (MIN_SAMPLE_RATE..=MAX_SAMPLE_RATE).contains(r))
                .unwrap_or(FALLBACK_SAMPLE_RATE);

            let _ = set_u32_property(
                unit,
                K_AUDIO_UNIT_PROPERTY_MAXIMUM_FRAMES_PER_SLICE,
                K_AUDIO_UNIT_SCOPE_GLOBAL,
                0,
                DEFAULT_MAX_FRAMES as u32,
            );
            let max_frames = get_u32_property(
                unit,
                K_AUDIO_UNIT_PROPERTY_MAXIMUM_FRAMES_PER_SLICE,
                K_AUDIO_UNIT_SCOPE_GLOBAL,
                0,
            )
            .map(|n| (n as usize).max(MIN_SCRATCH_FRAMES))
            .unwrap_or(MIN_SCRATCH_FRAMES);

            let input_cb = AURenderCallbackStruct {
                input_proc: Some(input_callback),
                input_proc_ref_con: ctx_ptr.cast(),
            };
            if AudioUnitSetProperty(
                unit,
                K_AUDIO_OUTPUT_UNIT_PROPERTY_SET_INPUT_CALLBACK,
                K_AUDIO_UNIT_SCOPE_GLOBAL,
                0,
                (&input_cb as *const AURenderCallbackStruct).cast(),
                std::mem::size_of::<AURenderCallbackStruct>() as u32,
            ) != 0
            {
                return Err(Failure::Device);
            }

            let output_cb = AURenderCallbackStruct {
                input_proc: Some(silent_output_callback),
                input_proc_ref_con: std::ptr::null_mut(),
            };
            let _ = AudioUnitSetProperty(
                unit,
                K_AUDIO_UNIT_PROPERTY_SET_RENDER_CALLBACK,
                K_AUDIO_UNIT_SCOPE_INPUT,
                K_OUTPUT_BUS,
                (&output_cb as *const AURenderCallbackStruct).cast(),
                std::mem::size_of::<AURenderCallbackStruct>() as u32,
            );

            // Try 16 kHz mono f32 first, then hardware/default-rate mono f32,
            // then the unit's original stream format.
            let mut initialized = false;
            for rate in [PREFERRED_SAMPLE_RATE, default_rate] {
                let in_target = mono_f32_asbd(rate);
                if set_asbd(unit, K_AUDIO_UNIT_SCOPE_OUTPUT, K_INPUT_BUS, &in_target) == 0 {
                    if let Some(ref orig_out) = orig_out_asbd {
                        let out_target = f32_asbd_for_rate(orig_out, rate);
                        let _ = set_asbd(unit, K_AUDIO_UNIT_SCOPE_INPUT, K_OUTPUT_BUS, &out_target);
                    }
                    if AudioUnitInitialize(unit) == 0 {
                        initialized = true;
                        break;
                    }
                }
            }

            if !initialized {
                if let Some(ref orig_in) = orig_in_asbd {
                    let _ = set_asbd(unit, K_AUDIO_UNIT_SCOPE_OUTPUT, K_INPUT_BUS, orig_in);
                }
                if let Some(ref orig_out) = orig_out_asbd {
                    let _ = set_asbd(unit, K_AUDIO_UNIT_SCOPE_INPUT, K_OUTPUT_BUS, orig_out);
                }
                if AudioUnitInitialize(unit) == 0 {
                    initialized = true;
                }
            }

            if !initialized {
                return Err(Failure::Device);
            }
            guard.initialized = true;

            let actual_asbd = get_asbd(unit, K_AUDIO_UNIT_SCOPE_OUTPUT, K_INPUT_BUS)
                .ok_or(Failure::Unsupported)?;
            let validated = validate_asbd(&actual_asbd)?;
            let (tap_input, chunker) = match tap_chunk_ms {
                Some(chunk_ms) => {
                    let (input, chunker) = tap(validated.sample_rate, 1, chunk_ms);
                    (Some(input), Some(chunker))
                }
                None => (None, None),
            };

            // SAFETY: `AudioOutputUnitStart` has not been called yet, so no
            // callback can read `ctx_ptr`.
            let ctx = &mut *ctx_ptr;
            ctx.format = validated;
            ctx.tap = tap_input;
            ctx.scratch = alloc_scratch(max_frames, validated.channels, validated.encoding);

            Ok((Box::new(guard), chunker))
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{audio_tap::tap, transcription::SAMPLE_RATE};
    use std::{f32::consts::PI, sync::Mutex};

    struct FakeUnitState {
        calls: Mutex<Vec<&'static str>>,
        fail_start: bool,
    }

    impl FakeUnitState {
        fn new(fail_start: bool) -> Arc<Self> {
            Arc::new(Self {
                calls: Mutex::new(Vec::new()),
                fail_start,
            })
        }

        fn calls(&self) -> Vec<&'static str> {
            self.calls.lock().unwrap().clone()
        }
    }

    struct FakeUnit(Arc<FakeUnitState>);

    impl VoiceUnitOps for FakeUnit {
        fn start(&self) -> i32 {
            self.0.calls.lock().unwrap().push("start");
            if self.0.fail_start {
                -50
            } else {
                0
            }
        }

        fn stop(&self) -> i32 {
            self.0.calls.lock().unwrap().push("stop");
            0
        }

        fn uninitialize(&self) -> i32 {
            self.0.calls.lock().unwrap().push("uninitialize");
            0
        }

        fn dispose(&mut self) -> i32 {
            self.0.calls.lock().unwrap().push("dispose");
            0
        }
    }

    fn tone(rate: u32, hz: f32, seconds: f32) -> Vec<f32> {
        (0..(rate as f32 * seconds) as usize)
            .map(|n| 0.4 * (2.0 * PI * hz * n as f32 / rate as f32).sin())
            .collect()
    }

    #[test]
    fn validates_f32_and_i16_formats_and_rejects_unsupported_ones() {
        let valid_16k = mono_f32_asbd(16_000.0);
        assert_eq!(
            validate_asbd(&valid_16k).unwrap(),
            ValidatedFormat {
                sample_rate: 16_000,
                channels: 1,
                is_non_interleaved: false,
                encoding: SampleEncoding::Float32,
            }
        );

        let valid_48k_planar = AudioStreamBasicDescription {
            mSampleRate: 48_000.0,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat
                | kAudioFormatFlagIsPacked
                | kAudioFormatFlagIsNonInterleaved,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: 2,
            mBitsPerChannel: 32,
            mReserved: 0,
        };
        assert_eq!(
            validate_asbd(&valid_48k_planar).unwrap(),
            ValidatedFormat {
                sample_rate: 48_000,
                channels: 2,
                is_non_interleaved: true,
                encoding: SampleEncoding::Float32,
            }
        );

        let valid_i16 = AudioStreamBasicDescription {
            mSampleRate: 44_100.0,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsSignedInteger | kAudioFormatFlagIsPacked,
            mBytesPerPacket: 2,
            mFramesPerPacket: 1,
            mBytesPerFrame: 2,
            mChannelsPerFrame: 1,
            mBitsPerChannel: 16,
            mReserved: 0,
        };
        assert_eq!(
            validate_asbd(&valid_i16).unwrap(),
            ValidatedFormat {
                sample_rate: 44_100,
                channels: 1,
                is_non_interleaved: false,
                encoding: SampleEncoding::SignedInt16,
            }
        );

        let mut big_endian = valid_16k;
        big_endian.mFormatFlags |= kAudioFormatFlagIsBigEndian;
        assert!(matches!(
            validate_asbd(&big_endian),
            Err(Failure::Unsupported)
        ));

        let mut bad_rate = valid_16k;
        bad_rate.mSampleRate = f64::NAN;
        assert!(matches!(
            validate_asbd(&bad_rate),
            Err(Failure::Unsupported)
        ));

        let mut too_many_channels = valid_16k;
        too_many_channels.mChannelsPerFrame = 32;
        assert!(matches!(
            validate_asbd(&too_many_channels),
            Err(Failure::Unsupported)
        ));

        let mut wrong_codec = valid_16k;
        wrong_codec.mFormatID = u32::from_be_bytes(*b"aac ");
        assert!(matches!(
            validate_asbd(&wrong_codec),
            Err(Failure::Unsupported)
        ));
    }

    #[test]
    fn f32_asbd_preserves_channel_count_and_non_interleaved_layout() {
        let stereo_planar = AudioStreamBasicDescription {
            mSampleRate: 48_000.0,
            mFormatID: kAudioFormatLinearPCM,
            mFormatFlags: kAudioFormatFlagIsFloat
                | kAudioFormatFlagIsPacked
                | kAudioFormatFlagIsNonInterleaved,
            mBytesPerPacket: 4,
            mFramesPerPacket: 1,
            mBytesPerFrame: 4,
            mChannelsPerFrame: 2,
            mBitsPerChannel: 32,
            mReserved: 0,
        };
        let converted = f32_asbd_for_rate(&stereo_planar, 16_000.0);
        assert_eq!(converted.mSampleRate, 16_000.0);
        assert_eq!(converted.mChannelsPerFrame, 2);
        assert_eq!(converted.mBytesPerFrame, 4);
        assert_ne!(converted.mFormatFlags & kAudioFormatFlagIsNonInterleaved, 0);
    }

    #[test]
    fn ring_ingest_resamples_48k_and_16k_to_16khz_mono_chunks() {
        for rate in [16_000u32, 48_000u32] {
            let meter = Arc::new(Meter::default());
            let (mut input, mut chunker) = tap(rate, 1, 100);
            let samples = tone(rate, 440.0, 0.35);
            let bytes: Vec<u8> = samples.iter().flat_map(|s| s.to_ne_bytes()).collect();
            let buf = RawPcmBuffer {
                channels: 1,
                data: bytes.as_ptr(),
                bytes: bytes.len(),
            };
            let format = ValidatedFormat {
                sample_rate: rate,
                channels: 1,
                is_non_interleaved: false,
                encoding: SampleEncoding::Float32,
            };
            unsafe {
                ingest_pcm_buffers(
                    &meter,
                    Some(&mut input),
                    &[buf],
                    samples.len(),
                    format,
                    false,
                );
            }
            assert_eq!(meter.blocks.load(Ordering::Acquire), 1);
            let chunks = chunker.drain(2_000);
            assert_eq!(chunks.len(), 3, "rate {rate}");
            for (idx, chunk) in chunks.iter().enumerate() {
                assert_eq!(chunk.samples.len(), SAMPLE_RATE / 10);
                assert_eq!(chunk.start_ms, 2_000 + idx as u64 * 100);
            }
        }
    }

    #[test]
    fn ring_ingest_handles_planar_stereo_i16_and_silence_without_stalling() {
        // Planar stereo f32: left carries +0.6, right carries -0.2 -> mono +0.2.
        let meter = Arc::new(Meter::default());
        let (mut input, mut chunker) = tap(16_000, 1, 100);
        let frames = 1_600usize;
        let left_bytes: Vec<u8> = vec![0.6f32; frames]
            .into_iter()
            .flat_map(f32::to_ne_bytes)
            .collect();
        let right_bytes: Vec<u8> = vec![-0.2f32; frames]
            .into_iter()
            .flat_map(f32::to_ne_bytes)
            .collect();
        let bufs = [
            RawPcmBuffer {
                channels: 1,
                data: left_bytes.as_ptr(),
                bytes: left_bytes.len(),
            },
            RawPcmBuffer {
                channels: 1,
                data: right_bytes.as_ptr(),
                bytes: right_bytes.len(),
            },
        ];
        let format = ValidatedFormat {
            sample_rate: 16_000,
            channels: 2,
            is_non_interleaved: true,
            encoding: SampleEncoding::Float32,
        };
        unsafe {
            ingest_pcm_buffers(&meter, Some(&mut input), &bufs, frames, format, false);
        }
        let chunks = chunker.drain(0);
        assert_eq!(chunks.len(), 1);
        assert!(chunks[0].samples.iter().all(|s| (s - 0.2).abs() < 1e-5));

        // Signed 16-bit integer PCM + OutputIsSilence flag preserves sample clock & meter blocks.
        let i16_bytes: Vec<u8> = vec![16_384i16; frames]
            .into_iter()
            .flat_map(i16::to_ne_bytes)
            .collect();
        let i16_buf = RawPcmBuffer {
            channels: 1,
            data: i16_bytes.as_ptr(),
            bytes: i16_bytes.len(),
        };
        let i16_format = ValidatedFormat {
            sample_rate: 16_000,
            channels: 1,
            is_non_interleaved: false,
            encoding: SampleEncoding::SignedInt16,
        };
        unsafe {
            ingest_pcm_buffers(
                &meter,
                Some(&mut input),
                &[i16_buf],
                frames,
                i16_format,
                false,
            );
            ingest_pcm_buffers(&meter, Some(&mut input), &[], frames, i16_format, true);
        }
        assert_eq!(meter.blocks.load(Ordering::Acquire), 3);
        let next = chunker.drain(0);
        assert_eq!(next.len(), 2);
        assert_eq!(next[0].start_ms, 100);
        assert!(next[0].samples.iter().all(|s| (s - 0.5).abs() < 1e-4));
        assert_eq!(next[1].start_ms, 200);
        assert!(next[1].samples.iter().all(|&s| s == 0.0));
    }

    #[test]
    fn scratch_allocation_is_16_byte_aligned_and_sufficiently_sized() {
        let scratch = alloc_scratch(MIN_SCRATCH_FRAMES, 2, SampleEncoding::Float32);
        let ptr = scratch.as_ptr() as usize;
        assert_eq!(ptr % 16, 0);
        assert!(scratch.len() * std::mem::size_of::<AlignedBlock>() >= MIN_SCRATCH_FRAMES * 2 * 4);
    }

    #[test]
    fn teardown_stops_uninitializes_and_disposes_in_order() {
        // 1. Started + initialized stream: Stop -> Uninitialize -> Dispose.
        let state = FakeUnitState::new(false);
        let ctx_ptr = Box::into_raw(Box::new(CallbackContext::new(
            std::ptr::null_mut(),
            Arc::new(Meter::default()),
            ValidatedFormat {
                sample_rate: 16_000,
                channels: 1,
                is_non_interleaved: false,
                encoding: SampleEncoding::Float32,
            },
        )));
        let mut stream =
            VoiceProcessingStream::new(FakeUnit(state.clone()), Some("Studio Mic".into()), ctx_ptr);
        stream.initialized = true;
        assert_eq!(stream.device_name(), Some("Studio Mic"));
        stream.play().unwrap();
        drop(stream);
        assert_eq!(state.calls(), ["start", "stop", "uninitialize", "dispose"]);

        // 2. Cancelled before play(): Uninitialize -> Dispose (no Stop).
        let state = FakeUnitState::new(false);
        let ctx_ptr = Box::into_raw(Box::new(CallbackContext::new(
            std::ptr::null_mut(),
            Arc::new(Meter::default()),
            ValidatedFormat {
                sample_rate: 16_000,
                channels: 1,
                is_non_interleaved: false,
                encoding: SampleEncoding::Float32,
            },
        )));
        let mut stream = VoiceProcessingStream::new(FakeUnit(state.clone()), None, ctx_ptr);
        stream.initialized = true;
        drop(stream);
        assert_eq!(state.calls(), ["uninitialize", "dispose"]);

        // 3. Failed before initialize or play() failure: Dispose only.
        let state = FakeUnitState::new(true);
        let ctx_ptr = Box::into_raw(Box::new(CallbackContext::new(
            std::ptr::null_mut(),
            Arc::new(Meter::default()),
            ValidatedFormat {
                sample_rate: 16_000,
                channels: 1,
                is_non_interleaved: false,
                encoding: SampleEncoding::Float32,
            },
        )));
        let stream = VoiceProcessingStream::new(FakeUnit(state.clone()), None, ctx_ptr);
        assert!(matches!(stream.play(), Err(Failure::Device)));
        drop(stream);
        assert_eq!(state.calls(), ["start", "dispose"]);
    }

    #[test]
    fn fallback_uses_cpal_calmly_when_voice_processing_fails_to_initialize() {
        struct StubStream(&'static str);
        impl CaptureStream for StubStream {
            fn play(&self) -> Result<(), Failure> {
                Ok(())
            }
            fn device_name(&self) -> Option<&str> {
                Some(self.0)
            }
        }

        // VoiceProcessingIO succeeds -> cpal is never invoked.
        let cpal_called = Arc::new(AtomicBool::new(false));
        let flag = cpal_called.clone();
        let (stream, chunker) = build_stream_with_fallback(
            Arc::new(Meter::default()),
            Some(100),
            |_, chunk_ms| {
                let (_input, chunker) = tap(16_000, 1, chunk_ms.unwrap());
                Ok((Box::new(StubStream("VoiceProcessingIO")), Some(chunker)))
            },
            move |_, _| {
                flag.store(true, Ordering::SeqCst);
                Ok((Box::new(StubStream("CPAL")), None))
            },
        )
        .unwrap();
        assert_eq!(stream.device_name(), Some("VoiceProcessingIO"));
        assert!(chunker.is_some());
        assert!(!cpal_called.load(Ordering::SeqCst));

        // VoiceProcessingIO fails -> falls back to CPAL cleanly.
        let (stream, chunker) = build_stream_with_fallback(
            Arc::new(Meter::default()),
            Some(100),
            |_, _| Err(Failure::Device),
            |_, chunk_ms| {
                let (_input, chunker) = tap(48_000, 1, chunk_ms.unwrap());
                Ok((Box::new(StubStream("CPAL Fallback")), Some(chunker)))
            },
        )
        .unwrap();
        assert_eq!(stream.device_name(), Some("CPAL Fallback"));
        assert!(chunker.is_some());

        // Both fail -> surfaces CPAL's error cleanly.
        let err = build_stream_with_fallback(
            Arc::new(Meter::default()),
            None,
            |_, _| Err(Failure::Unsupported),
            |_, _| Err(Failure::NoDevice),
        )
        .err();
        assert!(matches!(err, Some(Failure::NoDevice)));
    }

    #[test]
    fn ingest_callback_path_allocates_nothing() {
        let meter = Arc::new(Meter::default());
        let (mut input, _chunker) = tap(16_000, 1, 100);

        let mono_f32: Vec<u8> = tone(16_000, 300.0, 0.05)
            .into_iter()
            .flat_map(f32::to_ne_bytes)
            .collect();
        let left_f32 = mono_f32.clone();
        let right_f32 = mono_f32.clone();
        let i16_pcm: Vec<u8> = vec![4_096i16; 800]
            .into_iter()
            .flat_map(i16::to_ne_bytes)
            .collect();

        let mono_buf = [RawPcmBuffer {
            channels: 1,
            data: mono_f32.as_ptr(),
            bytes: mono_f32.len(),
        }];
        let planar_bufs = [
            RawPcmBuffer {
                channels: 1,
                data: left_f32.as_ptr(),
                bytes: left_f32.len(),
            },
            RawPcmBuffer {
                channels: 1,
                data: right_f32.as_ptr(),
                bytes: right_f32.len(),
            },
        ];
        let i16_buf = [RawPcmBuffer {
            channels: 1,
            data: i16_pcm.as_ptr(),
            bytes: i16_pcm.len(),
        }];

        let fmt_mono = ValidatedFormat {
            sample_rate: 16_000,
            channels: 1,
            is_non_interleaved: false,
            encoding: SampleEncoding::Float32,
        };
        let fmt_planar = ValidatedFormat {
            sample_rate: 16_000,
            channels: 2,
            is_non_interleaved: true,
            encoding: SampleEncoding::Float32,
        };
        let fmt_i16 = ValidatedFormat {
            sample_rate: 16_000,
            channels: 1,
            is_non_interleaved: false,
            encoding: SampleEncoding::SignedInt16,
        };

        let allocations = crate::microphone::tests::allocations_during(|| unsafe {
            ingest_pcm_buffers(&meter, Some(&mut input), &mono_buf, 800, fmt_mono, false);
            ingest_pcm_buffers(
                &meter,
                Some(&mut input),
                &planar_bufs,
                800,
                fmt_planar,
                false,
            );
            ingest_pcm_buffers(&meter, Some(&mut input), &i16_buf, 800, fmt_i16, false);
            ingest_pcm_buffers(&meter, Some(&mut input), &[], 800, fmt_mono, true);
        });
        assert_eq!(allocations, 0, "audio callback path must not allocate");
        assert_eq!(meter.blocks.load(Ordering::Acquire), 4);
    }

    #[test]
    fn ring_overrun_drops_without_blocking_and_preserves_session_clock_gap() {
        let meter = Arc::new(Meter::default());
        let (mut input, mut chunker) = tap(16_000, 1, 1_000);
        let format = ValidatedFormat {
            sample_rate: 16_000,
            channels: 1,
            is_non_interleaved: false,
            encoding: SampleEncoding::Float32,
        };
        // Push 5 seconds into a 4-second bounded ring: 1 second must drop.
        let five_seconds: Vec<u8> = vec![0.1f32; 16_000 * 5]
            .into_iter()
            .flat_map(f32::to_ne_bytes)
            .collect();
        let buf = [RawPcmBuffer {
            channels: 1,
            data: five_seconds.as_ptr(),
            bytes: five_seconds.len(),
        }];
        unsafe {
            ingest_pcm_buffers(&meter, Some(&mut input), &buf, 16_000 * 5, format, false);
        }
        assert_eq!(chunker.overruns(), 16_000);
        let first = chunker.drain(0);
        assert_eq!(first.len(), 4);
        assert_eq!(first.last().unwrap().start_ms, 3_000);

        // Next second starts at 5_000 ms, preserving the 1-second dropped gap.
        let one_second: Vec<u8> = vec![0.1f32; 16_000]
            .into_iter()
            .flat_map(f32::to_ne_bytes)
            .collect();
        let next_buf = [RawPcmBuffer {
            channels: 1,
            data: one_second.as_ptr(),
            bytes: one_second.len(),
        }];
        unsafe {
            ingest_pcm_buffers(&meter, Some(&mut input), &next_buf, 16_000, format, false);
        }
        let next = chunker.drain(0);
        assert_eq!(next[0].start_ms, 5_000);
    }

    #[test]
    fn teardown_is_idempotent_and_non_finite_samples_are_silenced() {
        let state = FakeUnitState::new(false);
        let ctx_ptr = Box::into_raw(Box::new(CallbackContext::new(
            std::ptr::null_mut(),
            Arc::new(Meter::default()),
            ValidatedFormat {
                sample_rate: 16_000,
                channels: 1,
                is_non_interleaved: false,
                encoding: SampleEncoding::Float32,
            },
        )));
        let mut stream = VoiceProcessingStream::new(FakeUnit(state.clone()), None, ctx_ptr);
        stream.initialized = true;
        stream.play().unwrap();
        stream.teardown();
        stream.teardown();
        drop(stream);
        assert_eq!(state.calls(), ["start", "stop", "uninitialize", "dispose"]);

        // NaN/Inf samples never propagate into the ring buffer.
        let meter = Arc::new(Meter::default());
        let (mut input, mut chunker) = tap(16_000, 1, 100);
        let mut bad = vec![f32::NAN, f32::INFINITY, f32::NEG_INFINITY, 0.25];
        bad.resize(1_600, 0.0);
        let bytes: Vec<u8> = bad.into_iter().flat_map(f32::to_ne_bytes).collect();
        let buf = [RawPcmBuffer {
            channels: 1,
            data: bytes.as_ptr(),
            bytes: bytes.len(),
        }];
        let fmt = ValidatedFormat {
            sample_rate: 16_000,
            channels: 1,
            is_non_interleaved: false,
            encoding: SampleEncoding::Float32,
        };
        unsafe {
            ingest_pcm_buffers(&meter, Some(&mut input), &buf, 1_600, fmt, false);
        }
        let chunk = &chunker.drain(0)[0];
        assert_eq!(&chunk.samples[..4], &[0.0, 0.0, 0.0, 0.25]);
    }
}
