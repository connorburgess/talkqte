//! Narrow CoreMedia PCM reader for the isolated native experiment. Its output
//! callback uses this reader. The eventual host must bind its clock origin to
//! session time and retire the operation on any error; never guess a format.

use crate::application_audio::handoff::MAX_SAMPLES;
use objc2_core_audio_types::{
    kAudioFormatFlagIsFloat, kAudioFormatFlagIsNonInterleaved, kAudioFormatFlagIsPacked,
    kAudioFormatLinearPCM, AudioBuffer, AudioBufferList, AudioStreamBasicDescription,
};
use objc2_core_media::{
    CMAudioFormatDescriptionGetStreamBasicDescription, CMSampleBuffer, CMSampleTimingInfo, CMTime,
    CMTimeFlags,
};
use std::ptr::NonNull;

const RATE: i128 = 16_000;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum PcmError {
    NotReady,
    Format,
    Size,
    Time,
    Overlap,
    Copy,
    NonFinite,
}

/// The initialized prefix of the caller's scratch array, on the source clock.
/// This carries no session/source authority and must not bypass the handoff.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PcmSpan {
    pub first_frame: u64,
    pub frames: usize,
}

/// One immutable 16 kHz mono float32 timeline. Any error permanently retires it.
/// No resampling, clock reset, silence insertion or inference is performed.
pub struct PcmReader {
    origin: CMTime,
    next_frame: u64,
    terminal: Option<PcmError>,
}

impl PcmReader {
    /// Supply a previously established source-clock origin. This does not
    /// establish its relationship to the engine clock or authorize capture.
    pub fn new(origin: CMTime) -> Result<Self, PcmError> {
        numeric(origin)?;
        Ok(Self {
            origin,
            next_frame: 0,
            terminal: None,
        })
    }

    /// Copy one bounded buffer into caller-owned scratch space. Only use the
    /// returned prefix on success; on error its contents are unspecified.
    /// Successfully read frames consume time even if the later handoff is full.
    ///
    /// # Safety
    /// The native sample buffer, its description and backing bytes must remain
    /// valid and immutable for this call. The eventual callback must establish
    /// that lifetime and serialize access to this reader/scratch buffer. Native
    /// copy latency/allocation behavior still needs callback-context validation.
    pub unsafe fn read(
        &mut self,
        sample: &CMSampleBuffer,
        scratch: &mut [f32; MAX_SAMPLES],
    ) -> Result<PcmSpan, PcmError> {
        if let Some(error) = self.terminal {
            return Err(error);
        }
        // SAFETY: caller guarantees stable native metadata and backing storage.
        let result = unsafe { self.read_inner(sample, scratch) };
        if let Err(error) = result {
            self.terminal = Some(error);
        }
        result
    }

    unsafe fn read_inner(
        &mut self,
        sample: &CMSampleBuffer,
        scratch: &mut [f32; MAX_SAMPLES],
    ) -> Result<PcmSpan, PcmError> {
        // SAFETY: same native lifetime contract as read. Inspect readiness,
        // format and bounded sizes before asking CoreMedia to copy any bytes.
        let (frames, pts, duration) = unsafe {
            if !sample.is_valid() || !sample.data_is_ready() {
                return Err(PcmError::NotReady);
            }
            let description = sample.format_description().ok_or(PcmError::Format)?;
            let asbd = CMAudioFormatDescriptionGetStreamBasicDescription(&description)
                .as_ref()
                .ok_or(PcmError::Format)?;
            validate_format(asbd)?;
            let frames = usize::try_from(sample.num_samples()).map_err(|_| PcmError::Size)?;
            if !(1..=MAX_SAMPLES).contains(&frames)
                || sample.total_sample_size() != frames * size_of::<f32>()
            {
                return Err(PcmError::Size);
            }
            let (mut size, mut entries) = (0usize, 0isize);
            if sample.sample_size_array(1, &mut size, &mut entries) != 0
                || entries != 1
                || size != 4
            {
                return Err(PcmError::Size);
            }
            let mut timing = CMSampleTimingInfo {
                duration: sample.duration(),
                presentationTimeStamp: sample.presentation_time_stamp(),
                decodeTimeStamp: sample.presentation_time_stamp(),
            };
            if sample.sample_timing_info_array(1, &mut timing, &mut entries) != 0 || entries != 1 {
                return Err(PcmError::Time);
            }
            numeric(timing.duration)?;
            if i128::from(timing.duration.value) * RATE != i128::from(timing.duration.timescale) {
                return Err(PcmError::Time);
            }
            (frames, timing.presentationTimeStamp, sample.duration())
        };
        numeric(duration)?;
        if i128::from(duration.value) * RATE != frames as i128 * i128::from(duration.timescale) {
            return Err(PcmError::Time);
        }
        let first_frame = frame_position(self.origin, pts)?;
        if first_frame < self.next_frame {
            return Err(PcmError::Overlap);
        }
        let end = first_frame
            .checked_add(frames as u64)
            .ok_or(PcmError::Time)?;
        let bytes = (frames * size_of::<f32>()) as u32;
        let mut buffers = AudioBufferList {
            mNumberBuffers: 1,
            mBuffers: [AudioBuffer {
                mNumberChannels: 1,
                mDataByteSize: bytes,
                mData: scratch.as_mut_ptr().cast(),
            }],
        };
        // SAFETY: verified mono float32 PCM, bounded frame count, one correctly
        // aligned writable buffer with capacity for every requested frame.
        let status = unsafe {
            sample.copy_pcm_data_into_audio_buffer_list(
                0,
                frames as i32,
                NonNull::from(&mut buffers),
            )
        };
        if status != 0
            || buffers.mNumberBuffers != 1
            || buffers.mBuffers[0].mNumberChannels != 1
            || buffers.mBuffers[0].mDataByteSize != bytes
            || buffers.mBuffers[0].mData != scratch.as_mut_ptr().cast()
        {
            return Err(PcmError::Copy);
        }
        if scratch[..frames].iter().any(|value| !value.is_finite()) {
            return Err(PcmError::NonFinite);
        }
        self.next_frame = end;
        Ok(PcmSpan {
            first_frame,
            frames,
        })
    }
}

fn validate_format(asbd: &AudioStreamBasicDescription) -> Result<(), PcmError> {
    let flags = kAudioFormatFlagIsFloat | kAudioFormatFlagIsPacked;
    // Mono planar and interleaved PCM both have one channel in one buffer.
    if asbd.mFormatID != kAudioFormatLinearPCM
        || ![flags, flags | kAudioFormatFlagIsNonInterleaved].contains(&asbd.mFormatFlags)
        || asbd.mSampleRate != RATE as f64
        || asbd.mChannelsPerFrame != 1
        || asbd.mBitsPerChannel != 32
        || asbd.mBytesPerFrame != 4
        || asbd.mFramesPerPacket != 1
        || asbd.mBytesPerPacket != 4
        || asbd.mReserved != 0
    {
        return Err(PcmError::Format);
    }
    Ok(())
}

fn numeric(time: CMTime) -> Result<(), PcmError> {
    // Reject rounded/indefinite/infinite values and clock epochs we cannot map.
    if time.flags != CMTimeFlags::Valid || time.timescale <= 0 || time.value < 0 || time.epoch != 0
    {
        return Err(PcmError::Time);
    }
    Ok(())
}

fn frame_position(origin: CMTime, pts: CMTime) -> Result<u64, PcmError> {
    numeric(pts)?;
    let delta = i128::from(pts.value) * i128::from(origin.timescale)
        - i128::from(origin.value) * i128::from(pts.timescale);
    let numerator = delta * RATE;
    let denominator = i128::from(pts.timescale) * i128::from(origin.timescale);
    // Exact rational mapping, not rounded arrival time or cumulative duration.
    // Unsupported sub-frame offsets fail closed rather than moving speech.
    if numerator < 0 || numerator % denominator != 0 {
        return Err(PcmError::Time);
    }
    u64::try_from(numerator / denominator).map_err(|_| PcmError::Time)
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;
    use objc2_core_foundation::CFRetained;
    use objc2_core_media::{
        kCMBlockBufferAssureMemoryNowFlag, CMAudioFormatDescriptionCreate, CMBlockBuffer,
        CMFormatDescription, CMSampleTimingInfo,
    };

    pub(crate) fn time(value: i64, timescale: i32) -> CMTime {
        CMTime {
            value,
            timescale,
            flags: CMTimeFlags::Valid,
            epoch: 0,
        }
    }

    pub(crate) fn format() -> AudioStreamBasicDescription {
        AudioStreamBasicDescription {
            mSampleRate: 16_000.0,
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

    // Construct only memory-backed fictional PCM. No ScreenCaptureKit object,
    // device, permission, dispatch callback, model or network is involved.
    pub(crate) fn sample(
        asbd: AudioStreamBasicDescription,
        samples: &[f32],
        pts: CMTime,
        duration: CMTime,
        backing: bool,
    ) -> CFRetained<CMSampleBuffer> {
        sample_with_metadata(asbd, samples, pts, duration, backing, &[4], None)
    }

    fn sample_with_metadata(
        mut asbd: AudioStreamBasicDescription,
        samples: &[f32],
        pts: CMTime,
        duration: CMTime,
        backing: bool,
        sizes: &[usize],
        timings: Option<&[CMSampleTimingInfo]>,
    ) -> CFRetained<CMSampleBuffer> {
        let mut description = std::ptr::null();
        // SAFETY: initialized ASBD and valid output pointer. CoreMedia copies it.
        unsafe {
            assert_eq!(
                CMAudioFormatDescriptionCreate(
                    None,
                    NonNull::from(&mut asbd),
                    0,
                    std::ptr::null(),
                    0,
                    std::ptr::null(),
                    None,
                    NonNull::from(&mut description)
                ),
                0
            );
        }
        // SAFETY: successful create returns ownership of a non-null description.
        let description: CFRetained<CMFormatDescription> =
            unsafe { CFRetained::from_raw(NonNull::new(description.cast_mut()).unwrap()) };
        let block = backing.then(|| {
            let size = std::mem::size_of_val(samples);
            let mut block = std::ptr::null_mut();
            // SAFETY: null memory asks CoreMedia to allocate its own backing;
            // initialization copies exactly size valid bytes from samples.
            unsafe {
                assert_eq!(
                    CMBlockBuffer::create_with_memory_block(
                        None,
                        std::ptr::null_mut(),
                        size,
                        None,
                        std::ptr::null(),
                        0,
                        size,
                        kCMBlockBufferAssureMemoryNowFlag,
                        NonNull::from(&mut block)
                    ),
                    0
                );
                let block = CFRetained::from_raw(NonNull::new(block).unwrap());
                assert_eq!(
                    CMBlockBuffer::replace_data_bytes(
                        NonNull::new(samples.as_ptr().cast_mut().cast()).unwrap(),
                        &block,
                        0,
                        size
                    ),
                    0
                );
                block
            }
        });
        let timing = CMSampleTimingInfo {
            duration,
            presentationTimeStamp: pts,
            decodeTimeStamp: time(0, 1),
        };
        let timings = timings.unwrap_or(std::slice::from_ref(&timing));
        let mut result = std::ptr::null_mut();
        // SAFETY: arrays have the declared lengths; one entry or one per frame
        // is supplied. Native objects/arrays live through creation and are retained/copied.
        unsafe {
            assert_eq!(
                CMSampleBuffer::create_ready(
                    None,
                    block.as_deref(),
                    Some(&description),
                    samples.len() as isize,
                    timings.len() as isize,
                    timings.as_ptr(),
                    sizes.len() as isize,
                    sizes.as_ptr(),
                    NonNull::from(&mut result)
                ),
                0
            );
            CFRetained::from_raw(NonNull::new(result).unwrap())
        }
    }

    fn pcm(samples: &[f32], pts: CMTime) -> CFRetained<CMSampleBuffer> {
        sample(format(), samples, pts, time(1, 16_000), true)
    }

    #[test]
    fn native_copy_keeps_values_and_exact_gaps_across_timescales() {
        let mut reader = PcmReader::new(time(10, 1)).unwrap();
        let mut scratch = [7.0; MAX_SAMPLES];
        let buffer = pcm(&[0.25, -0.5, 0.0, 1.25], time(160_000, 16_000));
        // SAFETY: immutable synthetic native storage lives through the read.
        let span = unsafe { reader.read(&buffer, &mut scratch) }.unwrap();
        drop(buffer);
        assert_eq!(
            span,
            PcmSpan {
                first_frame: 0,
                frames: 4
            }
        );
        assert_eq!(&scratch[..4], &[0.25, -0.5, 0.0, 1.25]);
        assert_eq!(scratch[4], 7.0);
        let mut planar = format();
        planar.mFormatFlags |= kAudioFormatFlagIsNonInterleaved;
        let buffer = sample(
            planar,
            &[0.75; 8],
            time(10_001_000_000, 1_000_000_000),
            time(1, 16_000),
            true,
        );
        let span = unsafe { reader.read(&buffer, &mut scratch) }.unwrap();
        assert_eq!(
            span,
            PcmSpan {
                first_frame: 16,
                frames: 8
            }
        );
        assert_eq!(&scratch[..8], &[0.75; 8]); // Frames [4,16) remain missing.
    }

    #[test]
    fn wrong_native_format_and_missing_backing_retire_without_silent_recovery() {
        let mut wrong_rate = format();
        wrong_rate.mSampleRate = 48_000.0;
        for (buffer, expected) in [
            (
                sample(wrong_rate, &[0.0; 8], time(0, 1), time(1, 48_000), true),
                PcmError::Format,
            ),
            (
                sample(format(), &[0.0; 8], time(0, 1), time(1, 16_000), false),
                PcmError::Copy,
            ),
        ] {
            let mut reader = PcmReader::new(time(0, 1)).unwrap();
            let mut scratch = [0.0; MAX_SAMPLES];
            assert_eq!(unsafe { reader.read(&buffer, &mut scratch) }, Err(expected));
            assert_eq!(
                unsafe { reader.read(&pcm(&[0.0; 8], time(8, 16_000)), &mut scratch) },
                Err(expected)
            );
        }
    }

    #[test]
    fn oversized_nonfinite_invalidated_and_wrong_duration_native_buffers_fail() {
        let invalidated = pcm(&[0.0; 8], time(0, 1));
        unsafe {
            invalidated.invalidate();
        }
        for (buffer, expected) in [
            (pcm(&[0.0; MAX_SAMPLES + 1], time(0, 1)), PcmError::Size),
            (pcm(&[0.0, f32::NAN], time(0, 1)), PcmError::NonFinite),
            (invalidated, PcmError::NotReady),
            (
                sample(format(), &[0.0; 8], time(0, 1), time(2, 16_000), true),
                PcmError::Time,
            ),
        ] {
            let mut reader = PcmReader::new(time(0, 1)).unwrap();
            assert_eq!(
                unsafe { reader.read(&buffer, &mut [0.0; MAX_SAMPLES]) },
                Err(expected)
            );
        }
    }

    #[test]
    fn overlapping_native_buffers_cannot_replay_already_consumed_frames() {
        let mut reader = PcmReader::new(time(0, 1)).unwrap();
        let mut scratch = [0.0; MAX_SAMPLES];
        assert_eq!(
            unsafe { reader.read(&pcm(&[0.0; MAX_SAMPLES], time(0, 1)), &mut scratch) }
                .unwrap()
                .frames,
            MAX_SAMPLES
        );
        assert_eq!(
            unsafe { reader.read(&pcm(&[0.0; 8], time(2047, 16_000)), &mut scratch) },
            Err(PcmError::Overlap)
        );
        assert_eq!(
            unsafe { reader.read(&pcm(&[0.0; 8], time(4096, 16_000)), &mut scratch) },
            Err(PcmError::Overlap)
        );
    }

    #[test]
    fn native_variable_frame_sizes_and_internal_timing_gaps_are_rejected() {
        let timings = [
            CMSampleTimingInfo {
                duration: time(1, 16_000),
                presentationTimeStamp: time(0, 1),
                decodeTimeStamp: time(0, 1),
            },
            CMSampleTimingInfo {
                duration: time(1, 16_000),
                presentationTimeStamp: time(2, 16_000),
                decodeTimeStamp: time(0, 1),
            },
        ];
        for (buffer, expected) in [
            (
                sample_with_metadata(
                    format(),
                    &[0.0; 2],
                    time(0, 1),
                    time(1, 16_000),
                    true,
                    &[2, 6],
                    None,
                ),
                PcmError::Size,
            ),
            (
                sample_with_metadata(
                    format(),
                    &[0.0; 2],
                    time(0, 1),
                    time(1, 16_000),
                    true,
                    &[4],
                    Some(&timings),
                ),
                PcmError::Time,
            ),
        ] {
            let mut reader = PcmReader::new(time(0, 1)).unwrap();
            assert_eq!(
                unsafe { reader.read(&buffer, &mut [0.0; MAX_SAMPLES]) },
                Err(expected)
            );
        }
    }

    #[test]
    fn format_contract_rejects_unsupported_layouts_before_copy() {
        for change in 0..11 {
            let mut asbd = format();
            match change {
                0 => asbd.mFormatID = 0,
                1 => asbd.mFormatFlags |= 2, // Big endian.
                2 => asbd.mSampleRate = f64::NAN,
                3 => asbd.mChannelsPerFrame = 2,
                4 => asbd.mBitsPerChannel = 16,
                5 => asbd.mBytesPerFrame = 8,
                6 => asbd.mFramesPerPacket = 2,
                7 => asbd.mBytesPerPacket = 8,
                8 => asbd.mReserved = 1,
                9 => asbd.mFormatFlags &= !kAudioFormatFlagIsFloat,
                _ => asbd.mFormatFlags |= 1 << 31,
            }
            assert_eq!(validate_format(&asbd), Err(PcmError::Format));
        }
    }

    #[test]
    fn clocks_reject_ambiguous_values_fractional_frames_and_overflow() {
        for change in 0..6 {
            let mut pts = time(1, 1);
            match change {
                0 => pts.flags = CMTimeFlags::empty(),
                1 => pts.flags |= CMTimeFlags::HasBeenRounded,
                2 => pts.flags |= CMTimeFlags::PositiveInfinity,
                3 => pts.timescale = 0,
                4 => pts.value = -1,
                _ => pts.epoch = 1,
            }
            assert!(PcmReader::new(pts).is_err());
            assert_eq!(frame_position(time(0, 1), pts), Err(PcmError::Time));
        }
        assert_eq!(frame_position(time(1, 1), time(0, 1)), Err(PcmError::Time));
        assert_eq!(
            frame_position(time(0, 1), time(1, 32_000)),
            Err(PcmError::Time)
        );
        assert_eq!(
            frame_position(time(0, 1), time(i64::MAX, 1)),
            Err(PcmError::Time)
        );
        // Wide intermediate arithmetic preserves exact offsets near i64::MAX.
        assert_eq!(
            frame_position(time(i64::MAX - 16, 16_000), time(i64::MAX - 8, 16_000)),
            Ok(8)
        );
    }
}
