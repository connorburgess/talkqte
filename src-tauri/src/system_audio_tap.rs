//! macOS 14.2+ Core Audio global system audio tap (`AudioHardwareCreateProcessTap`
//! + `CATapDescription` excluding TalkQTE's own process).
//!
//! Real-time audio rule: the Core Audio IOProc callback never allocates, locks,
//! blocks, logs, or performs I/O. It downmixes incoming PCM frames to mono f32
//! and pushes them straight into the lock-free `audio_tap` ring buffer (`rtrb`).
//! A dedicated worker thread drains and resamples to 16 kHz mono and feeds the
//! `Them` cloud transcription stream alongside the microphone (`You`).

use crate::{
    audio_tap::{Chunker, TapInput},
    live::DRAIN_EVERY,
    transcription::{cloud::CloudFeed, AudioChunk, SAMPLE_RATE},
};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    },
    thread::JoinHandle,
    time::{Duration, Instant},
};

/// Chunk size (ms) matching the microphone cloud transcription stream.
const CLOUD_CHUNK_MS: u64 = 100;
/// If no Core Audio buffer arrives for longer than this, re-align chunk times
/// to the session clock when audio resumes (e.g. after `tapautostart` delay).
const GAP_REALIGN_MS: u64 = 1_500;

/// Why the macOS global system audio tap could not start.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum TapError {
    /// Core Audio process taps require macOS 14.2 or later.
    Unsupported,
    /// System Audio Recording Only permission was denied or unavailable.
    PermissionDenied,
    /// Core Audio could not create or start the tap or aggregate device.
    StartFailed,
    /// The tap delivered an audio format TalkQTE cannot read.
    UnsupportedFormat,
}

impl TapError {
    pub fn ended_code(self) -> &'static str {
        match self {
            Self::Unsupported => "unsupported",
            Self::PermissionDenied => "permission_denied",
            Self::StartFailed | Self::UnsupportedFormat => "not_started",
        }
    }
}

/// An active native (or test) system-audio tap stream.
pub trait TapStream: Send {
    fn stop(&mut self);
}

/// Raw planar or interleaved f32 buffer view for downmixing without allocation.
pub(crate) struct RawF32Buffer {
    pub channels: u32,
    pub data: *const f32,
    pub floats: usize,
}

/// Downmixes Core Audio float32 buffers to mono and pushes each frame into the
/// lock-free `TapInput` ring. Allocation-free, lock-free, wait-free.
///
/// # Safety
/// Every `RawF32Buffer` with non-null `data` and `floats > 0` must point to at
/// least `floats` readable `f32` values for the duration of this call.
pub(crate) unsafe fn push_f32_buffers(
    input: &mut TapInput,
    buffers: &[RawF32Buffer],
    default_channels: usize,
    is_non_interleaved: bool,
) {
    if buffers.is_empty() {
        return;
    }
    if is_non_interleaved && buffers.len() > 1 {
        let mut active_channels = 0usize;
        let mut frames = usize::MAX;
        for buf in buffers {
            if !buf.data.is_null() && buf.floats > 0 {
                active_channels += 1;
                frames = frames.min(buf.floats);
            }
        }
        if active_channels == 0 || frames == usize::MAX || frames == 0 {
            return;
        }
        let scale = 1.0 / active_channels as f32;
        for frame in 0..frames {
            let mut sum = 0.0f32;
            for buf in buffers {
                if !buf.data.is_null() && buf.floats > frame {
                    // SAFETY: caller guarantees `data` has `floats > frame` readable f32s.
                    let sample = unsafe { std::ptr::read_unaligned(buf.data.add(frame)) };
                    if sample.is_finite() {
                        sum += sample;
                    }
                }
            }
            input.push_mono(sum * scale);
        }
        return;
    }

    let buf = &buffers[0];
    if buf.data.is_null() || buf.floats == 0 {
        return;
    }
    let ch = (buf.channels as usize).max(default_channels).max(1);
    let frames = buf.floats / ch;
    let scale = 1.0 / ch as f32;
    for frame in 0..frames {
        let base = frame * ch;
        let mut sum = 0.0f32;
        for c in 0..ch {
            // SAFETY: `base + c < frames * ch <= buf.floats`.
            let sample = unsafe { std::ptr::read_unaligned(buf.data.add(base + c)) };
            if sample.is_finite() {
                sum += sample;
            }
        }
        input.push_mono(sum * scale);
    }
}

/// Handle to a running (or starting) system audio tap worker.
pub struct Handle {
    stop: Arc<AtomicBool>,
    flush: Arc<AtomicBool>,
    started: Arc<AtomicBool>,
    thread: Option<JoinHandle<()>>,
}

impl Handle {
    /// Starts the macOS Core Audio global system audio tap on a dedicated
    /// worker thread, feeding `feed` (`Them`) alongside the microphone (`You`).
    #[cfg(target_os = "macos")]
    pub fn start(
        session: u64,
        session_start_ms: u64,
        feed: CloudFeed,
        on_attached: impl FnOnce() + Send + 'static,
        on_unavailable: impl FnOnce(TapError) + Send + 'static,
    ) -> Self {
        Self::start_with(
            session,
            session_start_ms,
            feed,
            native::open,
            on_attached,
            on_unavailable,
        )
    }

    /// Starts the tap worker with an explicit `open_tap` factory, allowing
    /// offline tests to drive the full lifecycle without touching Core Audio.
    pub fn start_with<F>(
        session: u64,
        session_start_ms: u64,
        mut feed: CloudFeed,
        open_tap: F,
        on_attached: impl FnOnce() + Send + 'static,
        on_unavailable: impl FnOnce(TapError) + Send + 'static,
    ) -> Self
    where
        F: FnOnce(u64) -> Result<(Chunker, Box<dyn TapStream>), TapError> + Send + 'static,
    {
        let stop = Arc::new(AtomicBool::new(false));
        let flush = Arc::new(AtomicBool::new(false));
        let started = Arc::new(AtomicBool::new(false));
        let stop_flag = stop.clone();
        let flush_flag = flush.clone();
        let started_flag = started.clone();

        let thread = std::thread::Builder::new()
            .name("talkqte-system-audio-tap".into())
            .spawn(move || {
                if stop_flag.load(Ordering::Acquire) {
                    feed.end();
                    return;
                }
                let (mut chunker, mut stream) = match open_tap(CLOUD_CHUNK_MS) {
                    Ok(opened) => opened,
                    Err(err) => {
                        if !stop_flag.load(Ordering::Acquire) {
                            on_unavailable(err);
                        }
                        feed.end();
                        return;
                    }
                };
                if stop_flag.load(Ordering::Acquire) {
                    stream.stop();
                    feed.end();
                    return;
                }
                started_flag.store(true, Ordering::Release);
                on_attached();

                let tap_started = Instant::now();
                let mut clock = TapClock::new(session_start_ms);
                let mut stream_stopped = false;

                while !stop_flag.load(Ordering::Acquire) {
                    let chunks = chunker.drain(0);
                    let now_elapsed = tap_started.elapsed();
                    if !chunks.is_empty() {
                        let timed = clock.align(chunks, now_elapsed);
                        for chunk in timed {
                            crate::timing_log::record_audio(
                                "application",
                                session,
                                chunk.start_ms,
                                &chunk.samples,
                            );
                            let end_ms = chunk_end_ms(&chunk, session_start_ms, now_elapsed);
                            let start_ms = chunk.start_ms.min(end_ms);
                            let _ = feed.push(start_ms, end_ms, &chunk.samples);
                        }
                    }
                    let _ = feed.poll();
                    if feed.failure().is_some() {
                        stream.stop();
                        stream_stopped = true;
                        break;
                    }
                    std::thread::sleep(DRAIN_EVERY);
                }

                if !stream_stopped {
                    stream.stop();
                }

                if flush_flag.load(Ordering::Acquire) && feed.failure().is_none() {
                    let now_elapsed = tap_started.elapsed();
                    let remaining = chunker.finish(0);
                    if !remaining.is_empty() {
                        for chunk in clock.align(remaining, now_elapsed) {
                            let end_ms = chunk_end_ms(&chunk, session_start_ms, now_elapsed);
                            let start_ms = chunk.start_ms.min(end_ms);
                            let _ = feed.push(start_ms, end_ms, &chunk.samples);
                        }
                    }
                    feed.finish(crate::live::FINISH_WAIT);
                } else {
                    feed.end();
                }
            })
            .expect("system audio tap thread starts");

        Self {
            stop,
            flush,
            started,
            thread: Some(thread),
        }
    }

    /// Stops the system audio tap and cleans up Core Audio resources. If the
    /// tap has already started, waits for teardown and optional flush; if it is
    /// still blocked waiting on an OS permission prompt, signals cancellation so
    /// Stop never hangs.
    pub fn stop(mut self, flush: bool) {
        self.flush.store(flush, Ordering::Release);
        self.stop.store(true, Ordering::Release);
        if self.started.load(Ordering::Acquire) {
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

impl Drop for Handle {
    fn drop(&mut self) {
        self.flush.store(false, Ordering::Release);
        self.stop.store(true, Ordering::Release);
        if self.started.load(Ordering::Acquire) {
            if let Some(thread) = self.thread.take() {
                let _ = thread.join();
            }
        }
    }
}

/// Aligns relative `Chunker` timestamps (`start_ms` from 0) onto the session
/// clock, accounting for `tapautostart` delays before the first audio arrives
/// or after long idle silences.
struct TapClock {
    session_start_ms: u64,
    base_ms: Option<u64>,
    last_audio_at: Option<Duration>,
}

impl TapClock {
    fn new(session_start_ms: u64) -> Self {
        Self {
            session_start_ms,
            base_ms: None,
            last_audio_at: None,
        }
    }

    fn align(&mut self, mut chunks: Vec<AudioChunk>, now_elapsed: Duration) -> Vec<AudioChunk> {
        let Some(first) = chunks.first() else {
            return chunks;
        };
        let last = chunks.last().expect("non-empty");
        let last_dur_ms = (last.samples.len() as u64 * 1_000) / SAMPLE_RATE as u64;
        let span_end_rel = last.start_ms.saturating_add(last_dur_ms);
        let drained_ms = span_end_rel.saturating_sub(first.start_ms);
        let now_session_ms = self
            .session_start_ms
            .saturating_add(u64::try_from(now_elapsed.as_millis()).unwrap_or(u64::MAX));

        match self.base_ms {
            None => {
                // Anchor the first batch so its end lands at `now_session_ms`.
                let anchored_start = now_session_ms.saturating_sub(drained_ms);
                self.base_ms = Some(anchored_start.saturating_sub(first.start_ms));
            }
            Some(base) => {
                let idle_gap = self.last_audio_at.is_some_and(|prev| {
                    now_elapsed.saturating_sub(prev) > Duration::from_millis(GAP_REALIGN_MS)
                });
                if idle_gap {
                    let anchored_start = now_session_ms.saturating_sub(drained_ms);
                    let candidate = anchored_start.saturating_sub(first.start_ms);
                    if candidate > base {
                        self.base_ms = Some(candidate);
                    }
                }
            }
        }
        self.last_audio_at = Some(now_elapsed);

        let base = self.base_ms.unwrap_or(self.session_start_ms);
        for chunk in &mut chunks {
            chunk.start_ms = base.saturating_add(chunk.start_ms).min(now_session_ms);
        }
        chunks
    }
}

fn chunk_end_ms(chunk: &AudioChunk, session_start_ms: u64, now_elapsed: Duration) -> u64 {
    let dur_ms = (chunk.samples.len() as u64 * 1_000) / SAMPLE_RATE as u64;
    let now_session_ms =
        session_start_ms.saturating_add(u64::try_from(now_elapsed.as_millis()).unwrap_or(u64::MAX));
    chunk
        .start_ms
        .saturating_add(dur_ms)
        .min(now_session_ms)
        .max(chunk.start_ms)
}

#[cfg(target_os = "macos")]
mod native {
    use super::{push_f32_buffers, RawF32Buffer, TapError, TapStream};
    use crate::audio_tap::{tap, Chunker, TapInput};
    use objc2::{
        msg_send,
        rc::{Allocated, Retained},
        runtime::{AnyClass, AnyObject},
    };
    use objc2_core_audio_types::{
        kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved, kAudioFormatLinearPCM,
        AudioBufferList, AudioStreamBasicDescription, AudioTimeStamp,
    };
    use objc2_foundation::{NSArray, NSDictionary, NSNumber, NSString, NSUUID};
    use std::ffi::{c_void, CStr};
    use std::sync::atomic::{AtomicBool, Ordering};

    const SYSTEM_OBJECT: u32 = 1;
    const GLOBAL_SCOPE: u32 = u32::from_be_bytes(*b"glob");
    const MAIN_ELEMENT: u32 = 0;

    const TRANSLATE_PID_TO_PROCESS_OBJECT: u32 = u32::from_be_bytes(*b"id2p");
    const TAP_PROPERTY_FORMAT: u32 = u32::from_be_bytes(*b"tfmt");

    const UNSUPPORTED_OPERATION_ERR: i32 = i32::from_be_bytes(*b"unop");
    const ILLEGAL_OPERATION_ERR: i32 = i32::from_be_bytes(*b"nope");
    const PERM_ERR: i32 = -54;
    const AUTH_DENIED_ERR: i32 = -60005;

    #[repr(C)]
    struct AudioObjectPropertyAddress {
        selector: u32,
        scope: u32,
        element: u32,
    }

    type AudioDeviceIOProc = unsafe extern "C" fn(
        in_device: u32,
        in_now: *const AudioTimeStamp,
        in_input_data: *const AudioBufferList,
        in_input_time: *const AudioTimeStamp,
        out_output_data: *mut AudioBufferList,
        in_output_time: *const AudioTimeStamp,
        in_client_data: *mut c_void,
    ) -> i32;

    type CreateProcessTapFn =
        unsafe extern "C" fn(in_description: *mut AnyObject, out_tap_id: *mut u32) -> i32;
    type DestroyProcessTapFn = unsafe extern "C" fn(in_tap_id: u32) -> i32;

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

        fn AudioHardwareCreateAggregateDevice(
            in_description: *const c_void,
            out_device_id: *mut u32,
        ) -> i32;

        fn AudioHardwareDestroyAggregateDevice(in_device_id: u32) -> i32;

        fn AudioDeviceCreateIOProcID(
            in_device: u32,
            in_proc: AudioDeviceIOProc,
            in_client_data: *mut c_void,
            out_io_proc_id: *mut *mut c_void,
        ) -> i32;

        fn AudioDeviceDestroyIOProcID(in_device: u32, in_io_proc_id: *mut c_void) -> i32;

        fn AudioDeviceStart(in_device: u32, in_proc_id: *mut c_void) -> i32;

        fn AudioDeviceStop(in_device: u32, in_proc_id: *mut c_void) -> i32;
    }

    struct IoProcContext {
        input: TapInput,
        channels: usize,
        is_non_interleaved: bool,
        stopped: AtomicBool,
    }

    unsafe extern "C" fn io_proc(
        _in_device: u32,
        _in_now: *const AudioTimeStamp,
        in_input_data: *const AudioBufferList,
        _in_input_time: *const AudioTimeStamp,
        _out_output_data: *mut AudioBufferList,
        _in_output_time: *const AudioTimeStamp,
        in_client_data: *mut c_void,
    ) -> i32 {
        if in_client_data.is_null() || in_input_data.is_null() {
            return 0;
        }
        // SAFETY: `in_client_data` stays alive until after `AudioDeviceDestroyIOProcID`
        // returns; Core Audio runs one IOProc invocation at a time per IOProcID.
        let ctx = unsafe { &mut *(in_client_data as *mut IoProcContext) };
        if ctx.stopped.load(Ordering::Acquire) {
            return 0;
        }
        let list = unsafe { &*in_input_data };
        let num_buffers = list.mNumberBuffers as usize;
        if num_buffers == 0 {
            return 0;
        }
        let audio_buffers =
            unsafe { std::slice::from_raw_parts(list.mBuffers.as_ptr(), num_buffers) };
        // Fixed-capacity stack array so the real-time callback never allocates.
        const MAX_BUFFERS: usize = 16;
        let count = num_buffers.min(MAX_BUFFERS);
        let mut raw = [const {
            RawF32Buffer {
                channels: 0,
                data: std::ptr::null(),
                floats: 0,
            }
        }; MAX_BUFFERS];
        for (dst, src) in raw[..count].iter_mut().zip(&audio_buffers[..count]) {
            dst.channels = src.mNumberChannels;
            dst.data = src.mData.cast::<f32>();
            dst.floats = src.mDataByteSize as usize / std::mem::size_of::<f32>();
        }
        unsafe {
            push_f32_buffers(
                &mut ctx.input,
                &raw[..count],
                ctx.channels,
                ctx.is_non_interleaved,
            );
        }
        0
    }

    pub(crate) struct CoreAudioTapStream {
        tap_id: u32,
        aggregate_id: u32,
        io_proc_id: *mut c_void,
        started: bool,
        ctx_ptr: *mut IoProcContext,
        destroy_tap: DestroyProcessTapFn,
        torn_down: bool,
    }

    // SAFETY: CoreAudioTapStream is created, used, and destroyed on its dedicated
    // worker thread, and `Box<dyn TapStream>` requires `Send`.
    unsafe impl Send for CoreAudioTapStream {}

    impl CoreAudioTapStream {
        fn teardown(&mut self) {
            if self.torn_down {
                return;
            }
            self.torn_down = true;
            if !self.ctx_ptr.is_null() {
                // SAFETY: `ctx_ptr` remains valid until after `AudioDeviceDestroyIOProcID`.
                unsafe { (*self.ctx_ptr).stopped.store(true, Ordering::Release) };
            }
            if self.started && self.aggregate_id != 0 && !self.io_proc_id.is_null() {
                unsafe {
                    let _ = AudioDeviceStop(self.aggregate_id, self.io_proc_id);
                }
                self.started = false;
            }
            if self.aggregate_id != 0 && !self.io_proc_id.is_null() {
                unsafe {
                    let _ = AudioDeviceDestroyIOProcID(self.aggregate_id, self.io_proc_id);
                }
                self.io_proc_id = std::ptr::null_mut();
            }
            if self.aggregate_id != 0 {
                unsafe {
                    let _ = AudioHardwareDestroyAggregateDevice(self.aggregate_id);
                }
                self.aggregate_id = 0;
            }
            if self.tap_id != 0 {
                unsafe {
                    let _ = (self.destroy_tap)(self.tap_id);
                }
                self.tap_id = 0;
            }
            if !self.ctx_ptr.is_null() {
                // SAFETY: IOProc has been stopped and destroyed, so no callback can read `ctx_ptr`.
                drop(unsafe { Box::from_raw(self.ctx_ptr) });
                self.ctx_ptr = std::ptr::null_mut();
            }
        }
    }

    impl TapStream for CoreAudioTapStream {
        fn stop(&mut self) {
            self.teardown();
        }
    }

    impl Drop for CoreAudioTapStream {
        fn drop(&mut self) {
            self.teardown();
        }
    }

    unsafe fn dlsym_fn(name: &CStr) -> Option<*mut c_void> {
        let sym = unsafe { libc::dlsym(libc::RTLD_DEFAULT, name.as_ptr()) };
        (!sym.is_null()).then_some(sym)
    }

    fn map_tap_status(status: i32) -> TapError {
        match status {
            UNSUPPORTED_OPERATION_ERR => TapError::Unsupported,
            ILLEGAL_OPERATION_ERR | PERM_ERR | AUTH_DENIED_ERR => TapError::PermissionDenied,
            _ => TapError::StartFailed,
        }
    }

    fn self_process_object() -> Result<u32, TapError> {
        let pid = std::process::id() as i32;
        let address = AudioObjectPropertyAddress {
            selector: TRANSLATE_PID_TO_PROCESS_OBJECT,
            scope: GLOBAL_SCOPE,
            element: MAIN_ELEMENT,
        };
        let mut process_obj: u32 = 0;
        let mut size = std::mem::size_of::<u32>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                SYSTEM_OBJECT,
                &address,
                std::mem::size_of::<i32>() as u32,
                (&pid as *const i32).cast(),
                &mut size,
                (&mut process_obj as *mut u32).cast(),
            )
        };
        if status != 0 || process_obj == 0 {
            return Err(map_tap_status(status));
        }
        Ok(process_obj)
    }

    fn read_tap_format(tap_id: u32) -> Result<AudioStreamBasicDescription, TapError> {
        let address = AudioObjectPropertyAddress {
            selector: TAP_PROPERTY_FORMAT,
            scope: GLOBAL_SCOPE,
            element: MAIN_ELEMENT,
        };
        let mut asbd: AudioStreamBasicDescription = unsafe { std::mem::zeroed() };
        let mut size = std::mem::size_of::<AudioStreamBasicDescription>() as u32;
        let status = unsafe {
            AudioObjectGetPropertyData(
                tap_id,
                &address,
                0,
                std::ptr::null(),
                &mut size,
                (&mut asbd as *mut AudioStreamBasicDescription).cast(),
            )
        };
        if status != 0 || size as usize != std::mem::size_of::<AudioStreamBasicDescription>() {
            return Err(TapError::UnsupportedFormat);
        }
        if asbd.mFormatID != kAudioFormatLinearPCM
            || (asbd.mFormatFlags & kAudioFormatFlagIsFloat) == 0
            || asbd.mBitsPerChannel != 32
            || !asbd.mSampleRate.is_finite()
            || asbd.mSampleRate < 8_000.0
            || asbd.mSampleRate > 384_000.0
            || asbd.mChannelsPerFrame == 0
            || asbd.mChannelsPerFrame > 16
        {
            return Err(TapError::UnsupportedFormat);
        }
        Ok(asbd)
    }

    pub(crate) fn open(chunk_ms: u64) -> Result<(Chunker, Box<dyn TapStream>), TapError> {
        let create_sym =
            unsafe { dlsym_fn(c"AudioHardwareCreateProcessTap") }.ok_or(TapError::Unsupported)?;
        let destroy_sym =
            unsafe { dlsym_fn(c"AudioHardwareDestroyProcessTap") }.ok_or(TapError::Unsupported)?;
        let create_tap: CreateProcessTapFn = unsafe { std::mem::transmute(create_sym) };
        let destroy_tap: DestroyProcessTapFn = unsafe { std::mem::transmute(destroy_sym) };

        let tap_cls = AnyClass::get(c"CATapDescription").ok_or(TapError::Unsupported)?;
        let self_obj = self_process_object()?;

        let exclude_num = NSNumber::new_u32(self_obj);
        let exclude_arr = NSArray::from_slice(&[&*exclude_num]);
        let allocated: Allocated<AnyObject> = unsafe { msg_send![tap_cls, alloc] };
        let desc: Option<Retained<AnyObject>> =
            unsafe { msg_send![allocated, initStereoGlobalTapButExcludeProcesses: &*exclude_arr] };
        let desc = desc.ok_or(TapError::StartFailed)?;

        let uuid = NSUUID::new();
        let tap_uid = uuid.UUIDString();
        let tap_name = NSString::from_str("TalkQTE System Audio Tap");
        unsafe {
            let _: () = msg_send![&*desc, setUUID: &*uuid];
            let _: () = msg_send![&*desc, setName: &*tap_name];
            let _: () = msg_send![&*desc, setMuteBehavior: 0isize];
            let _: () = msg_send![&*desc, setPrivate: true];
        }

        let mut tap_id: u32 = 0;
        let status = unsafe { create_tap(Retained::as_ptr(&desc) as *mut AnyObject, &mut tap_id) };
        if status != 0 || tap_id == 0 {
            return Err(map_tap_status(status));
        }

        // Guard every subsequent step so a failure tears down all created Core Audio objects.
        let mut guard = CoreAudioTapStream {
            tap_id,
            aggregate_id: 0,
            io_proc_id: std::ptr::null_mut(),
            started: false,
            ctx_ptr: std::ptr::null_mut(),
            destroy_tap,
            torn_down: false,
        };

        let asbd = read_tap_format(tap_id)?;
        let sample_rate = asbd.mSampleRate.round() as u32;
        let channels = asbd.mChannelsPerFrame as usize;
        let is_non_interleaved = (asbd.mFormatFlags & kAudioFormatFlagIsNonInterleaved) != 0;

        let agg_name = NSString::from_str("TalkQTE System Audio");
        let agg_uid = NSString::from_str(&format!(
            "com.talkqte.desktop.system-tap.{}",
            NSUUID::new().UUIDString()
        ));
        let one = NSNumber::new_i32(1);
        let zero = NSNumber::new_i32(0);

        let sub_tap_keys: [&NSString; 2] =
            [&NSString::from_str("uid"), &NSString::from_str("drift")];
        let sub_tap_vals: [&AnyObject; 2] = [tap_uid.as_ref(), one.as_ref()];
        let sub_tap = NSDictionary::from_slices(&sub_tap_keys, &sub_tap_vals);
        let tap_list = NSArray::from_slice(&[&*sub_tap]);

        let agg_keys: [&NSString; 6] = [
            &NSString::from_str("name"),
            &NSString::from_str("uid"),
            &NSString::from_str("private"),
            &NSString::from_str("stacked"),
            &NSString::from_str("tapautostart"),
            &NSString::from_str("taps"),
        ];
        let agg_vals: [&AnyObject; 6] = [
            agg_name.as_ref(),
            agg_uid.as_ref(),
            one.as_ref(),
            zero.as_ref(),
            one.as_ref(),
            tap_list.as_ref(),
        ];
        let agg_dict = NSDictionary::from_slices(&agg_keys, &agg_vals);

        let mut aggregate_id: u32 = 0;
        let status = unsafe {
            AudioHardwareCreateAggregateDevice(
                Retained::as_ptr(&agg_dict).cast(),
                &mut aggregate_id,
            )
        };
        if status != 0 || aggregate_id == 0 {
            return Err(map_tap_status(status));
        }
        guard.aggregate_id = aggregate_id;

        // Downmixed mono f32 samples go directly into the 1-channel ring.
        let (input, chunker) = tap(sample_rate, 1, chunk_ms);
        let ctx_ptr = Box::into_raw(Box::new(IoProcContext {
            input,
            channels,
            is_non_interleaved,
            stopped: AtomicBool::new(false),
        }));
        guard.ctx_ptr = ctx_ptr;

        let mut io_proc_id: *mut c_void = std::ptr::null_mut();
        let status = unsafe {
            AudioDeviceCreateIOProcID(aggregate_id, io_proc, ctx_ptr.cast(), &mut io_proc_id)
        };
        if status != 0 || io_proc_id.is_null() {
            return Err(map_tap_status(status));
        }
        guard.io_proc_id = io_proc_id;

        let status = unsafe { AudioDeviceStart(aggregate_id, io_proc_id) };
        if status != 0 {
            return Err(map_tap_status(status));
        }
        guard.started = true;

        Ok((chunker, Box::new(guard)))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{
        audio_tap::tap,
        engine::{Engine, LineOrigin, SessionSources, THEM, YOU},
        transcription::cloud::{Full, StreamingTranscriber, SttEvent},
    };
    use std::sync::{atomic::AtomicU64, mpsc};

    #[derive(Clone, Default)]
    struct FakeStreamState {
        stopped: Arc<AtomicU64>,
    }

    struct FakeStream(FakeStreamState);

    impl TapStream for FakeStream {
        fn stop(&mut self) {
            self.0.stopped.fetch_add(1, Ordering::SeqCst);
        }
    }

    #[derive(Clone)]
    struct Loudness {
        line: &'static str,
        loud: Arc<AtomicU64>,
        received: Arc<AtomicU64>,
        finals: Arc<AtomicU64>,
        aborted: Arc<AtomicBool>,
    }

    impl Loudness {
        fn new(line: &'static str) -> Self {
            Self {
                line,
                loud: Arc::default(),
                received: Arc::default(),
                finals: Arc::default(),
                aborted: Arc::default(),
            }
        }

        fn final_(&self, start: u64, samples: u64) -> SttEvent {
            let seq = self.finals.fetch_add(1, Ordering::SeqCst) + 1;
            let start_ms = start * 1_000 / SAMPLE_RATE as u64;
            SttEvent::Final {
                seq,
                text: self.line.into(),
                start_ms,
                end_ms: start_ms + samples * 1_000 / SAMPLE_RATE as u64,
                untrusted_speaker: Some(0),
            }
        }
    }

    impl StreamingTranscriber for Loudness {
        fn push(&mut self, samples: &[f32]) -> Result<(), Full> {
            let loud = samples.iter().filter(|sample| sample.abs() > 0.1).count() as u64;
            self.loud.fetch_add(loud, Ordering::SeqCst);
            self.received
                .fetch_add(samples.len() as u64, Ordering::SeqCst);
            Ok(())
        }

        fn poll(&mut self) -> Vec<SttEvent> {
            let loud = self.loud.load(Ordering::SeqCst);
            if loud < SAMPLE_RATE as u64 {
                return vec![SttEvent::Partial];
            }
            self.loud.fetch_sub(SAMPLE_RATE as u64, Ordering::SeqCst);
            let end = self.received.load(Ordering::SeqCst);
            vec![self.final_(end.saturating_sub(loud), SAMPLE_RATE as u64)]
        }

        fn finish(&mut self, _: Duration) -> Vec<SttEvent> {
            let mut events = self.poll();
            let left = self.loud.swap(0, Ordering::SeqCst);
            if left > 0 {
                let end = self.received.load(Ordering::SeqCst);
                events.push(self.final_(end - left, left));
            }
            events
        }

        fn abort(&mut self) {
            self.aborted.store(true, Ordering::SeqCst);
        }
    }

    #[test]
    fn downmixes_interleaved_and_non_interleaved_stereo_buffers_to_mono_ring() {
        // Interleaved stereo: L=0.6, R=0.2 -> mono=0.4; L=NaN, R=-0.8 -> mono=-0.4
        let (mut input, mut chunker) = tap(16_000, 1, 100);
        let mut interleaved = vec![0.6f32, 0.2, f32::NAN, -0.8];
        interleaved.extend(std::iter::repeat_n(0.5f32, 1_598 * 2));
        let raw = [RawF32Buffer {
            channels: 2,
            data: interleaved.as_ptr(),
            floats: interleaved.len(),
        }];
        unsafe { push_f32_buffers(&mut input, &raw, 2, false) };
        let chunks = chunker.drain(0);
        assert_eq!(chunks.len(), 1);
        assert!((chunks[0].samples[0] - 0.4).abs() < 1e-5);
        assert!((chunks[0].samples[1] - (-0.4)).abs() < 1e-5);

        // Non-interleaved stereo: two buffers of mono frames.
        let (mut input2, mut chunker2) = tap(16_000, 1, 100);
        let left = vec![0.8f32; 1_600];
        let right = vec![0.2f32; 1_600];
        let raw_ni = [
            RawF32Buffer {
                channels: 1,
                data: left.as_ptr(),
                floats: left.len(),
            },
            RawF32Buffer {
                channels: 1,
                data: right.as_ptr(),
                floats: right.len(),
            },
        ];
        unsafe { push_f32_buffers(&mut input2, &raw_ni, 2, true) };
        let chunks2 = chunker2.drain(0);
        assert_eq!(chunks2.len(), 1);
        assert!((chunks2[0].samples[0] - 0.5).abs() < 1e-5);
    }

    #[test]
    fn tap_lifecycle_routes_them_alongside_you_and_tears_down_cleanly_on_stop() {
        let mut engine = Engine::live();
        engine.start().unwrap();
        engine.set_sources(SessionSources::system_audio());
        let session = engine.session();
        let engine = Arc::new(std::sync::Mutex::new(engine));

        let (tx, rx) = mpsc::channel();
        let (attached_tx, attached_rx) = mpsc::channel();
        let state = FakeStreamState::default();
        let state_for_open = state.clone();

        let (mut input, chunker) = tap(16_000, 1, CLOUD_CHUNK_MS);
        let stream = Loudness::new("Can we ship Friday?");
        let opened = stream.clone();
        let eng_sink = engine.clone();
        let feed = CloudFeed::new(
            session,
            1,
            Box::new(move || Ok(Box::new(opened) as Box<dyn StreamingTranscriber>)),
            || Some(0),
            move |sess, segment| {
                let mut e = eng_sink.lock().unwrap();
                let behind = segment.at_ms.saturating_sub(e.state.elapsed_ms);
                e.advance(behind);
                let res = e.ingest_from(sess, LineOrigin::Application, segment);
                let _ = tx.send(res.is_ok());
                res
            },
        );

        let handle = Handle::start_with(
            session,
            0,
            feed,
            move |_| Ok((chunker, Box::new(FakeStream(state_for_open)))),
            move || {
                let _ = attached_tx.send(());
            },
            |_| panic!("unexpected failure"),
        );

        attached_rx.recv_timeout(Duration::from_secs(2)).unwrap();
        // Feed 1 second of system audio (Them), then ingest a mic line (You).
        let buf = vec![0.5f32; SAMPLE_RATE];
        let raw = [RawF32Buffer {
            channels: 1,
            data: buf.as_ptr(),
            floats: buf.len(),
        }];
        unsafe { push_f32_buffers(&mut input, &raw, 1, false) };

        assert!(rx.recv_timeout(Duration::from_secs(5)).unwrap());
        {
            let mut e = engine.lock().unwrap();
            e.advance(1_500);
            e.ingest_from(
                session,
                LineOrigin::Microphone,
                crate::engine::Segment {
                    id: "mic-1".into(),
                    at_ms: 1_200,
                    speaker: "Speaker".into(),
                    text: "Yes, let's check with legal first.".into(),
                },
            )
            .unwrap();
        }

        handle.stop(true);
        assert_eq!(state.stopped.load(Ordering::SeqCst), 1);

        let e = engine.lock().unwrap();
        assert_eq!(e.state.transcript.len(), 2);
        assert_eq!(e.state.transcript[0].speaker, THEM);
        assert_eq!(e.state.transcript[0].text, "Can we ship Friday?");
        assert_eq!(e.state.transcript[1].speaker, YOU);
        assert_eq!(
            e.state.transcript[1].text,
            "Yes, let's check with legal first."
        );
    }

    #[test]
    fn unavailable_or_denied_system_audio_falls_back_to_microphone_only_gracefully() {
        for err in [TapError::Unsupported, TapError::PermissionDenied] {
            let mut engine = Engine::live();
            engine.start().unwrap();
            engine.set_sources(SessionSources::system_audio());
            let session = engine.session();
            let engine = Arc::new(std::sync::Mutex::new(engine));
            let (done_tx, done_rx) = mpsc::channel();
            let eng_err = engine.clone();
            let feed = CloudFeed::new(
                session,
                1,
                Box::new(|| panic!("stream should not open when tap fails")),
                || Some(0),
                |_, _| Ok(()),
            );

            let handle = Handle::start_with(
                session,
                0,
                feed,
                move |_| Err(err),
                || panic!("should not attach on error"),
                move |tap_err| {
                    eng_err
                        .lock()
                        .unwrap()
                        .application_ended(session, tap_err.ended_code());
                    let _ = done_tx.send(tap_err);
                },
            );

            let got = done_rx.recv_timeout(Duration::from_secs(2)).unwrap();
            assert_eq!(got, err);
            handle.stop(false);

            let mut e = engine.lock().unwrap();
            assert_eq!(
                e.state
                    .sources
                    .as_ref()
                    .and_then(|s| s.application_ended.as_deref()),
                Some(err.ended_code())
            );
            // Microphone continues uninterrupted.
            e.advance(500);
            assert!(e
                .ingest_from(
                    session,
                    LineOrigin::Microphone,
                    crate::engine::Segment {
                        id: "mic-fallback".into(),
                        at_ms: 400,
                        speaker: "Speaker".into(),
                        text: "Microphone still works.".into(),
                    },
                )
                .is_ok());
        }
    }

    #[test]
    fn tap_clock_aligns_delayed_first_audio_and_long_idle_gaps() {
        let mut clock = TapClock::new(1_000);
        let first = vec![AudioChunk {
            start_ms: 0,
            samples: vec![0.0; SAMPLE_RATE / 10], // 100 ms
        }];
        let aligned = clock.align(first, Duration::from_millis(5_100));
        // Session started at 1000ms + 5100ms elapsed - 100ms chunk = 6000ms.
        assert_eq!(aligned[0].start_ms, 6_000);

        // Normal continuous chunk 100ms later stays sample-accurate.
        let second = vec![AudioChunk {
            start_ms: 100,
            samples: vec![0.0; SAMPLE_RATE / 10],
        }];
        let aligned2 = clock.align(second, Duration::from_millis(5_200));
        assert_eq!(aligned2[0].start_ms, 6_100);

        // Long idle gap (>1.5s without IOProc callbacks) re-aligns forward.
        let third = vec![AudioChunk {
            start_ms: 200,
            samples: vec![0.0; SAMPLE_RATE / 10],
        }];
        let aligned3 = clock.align(third, Duration::from_millis(10_200));
        assert_eq!(aligned3[0].start_ms, 11_100);
    }
}
