//! Platform permission and input-stream adapter. Constructing this module does
//! not query a device or request access; only the explicit start command does.
//!
//! The input stream is cpal's on every platform built here: Core Audio on
//! macOS, WASAPI (shared mode) on Windows, ALSA on Linux, where desktop
//! Ubuntu's default ALSA device is PipeWire's (through `pipewire-alsa`) or
//! PulseAudio's. Only macOS has an access prompt to ask first. Windows has a
//! privacy switch instead (Settings → Privacy & security → Microphone →
//! "Let desktop apps access your microphone"); when it is off, opening the
//! stream fails and the start reports a device error. Linux has none.
use super::{CaptureStream, Failure, Meter};
use std::sync::Arc;

#[cfg(target_os = "macos")]
pub(crate) fn request_permission(complete: impl Fn(Result<(), Failure>) + Send + Sync + 'static) {
    use block2::RcBlock;
    use objc2::runtime::Bool;
    use objc2_av_foundation::{AVAuthorizationStatus, AVCaptureDevice, AVMediaTypeAudio};

    // These APIs accept the system's static audio media type. The completion
    // block owns its captured state and is copied by AVFoundation while pending.
    unsafe {
        let Some(audio) = AVMediaTypeAudio else {
            complete(Err(Failure::Unsupported));
            return;
        };
        match AVCaptureDevice::authorizationStatusForMediaType(audio) {
            AVAuthorizationStatus::Authorized => complete(Ok(())),
            AVAuthorizationStatus::NotDetermined => {
                let block = RcBlock::new(move |allowed: Bool| {
                    complete(if allowed.as_bool() {
                        Ok(())
                    } else {
                        Err(Failure::Permission)
                    });
                });
                AVCaptureDevice::requestAccessForMediaType_completionHandler(audio, &block);
            }
            _ => complete(Err(Failure::Permission)),
        }
    }
}

/// Windows and Linux have no access prompt for a desktop app to request:
/// the stream itself is the check.
#[cfg(any(windows, target_os = "linux"))]
pub(crate) fn request_permission(complete: impl Fn(Result<(), Failure>) + Send + Sync + 'static) {
    complete(Ok(()));
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
pub(crate) fn request_permission(complete: impl Fn(Result<(), Failure>) + Send + Sync + 'static) {
    complete(Err(Failure::Unsupported));
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
struct InputStream {
    stream: cpal::Stream,
    device_name: Option<String>,
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
impl CaptureStream for InputStream {
    fn play(&self) -> Result<(), Failure> {
        cpal::traits::StreamTrait::play(&self.stream).map_err(|_| Failure::Device)
    }
    fn device_name(&self) -> Option<&str> {
        self.device_name.as_deref()
    }
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn input<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    meter: Arc<Meter>,
    tap: Option<crate::audio_tap::TapInput>,
) -> Result<Box<dyn CaptureStream>, Failure>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    use cpal::traits::DeviceTrait;
    use std::{sync::atomic::Ordering, time::Duration};
    let failures = meter.clone();
    let mut tap = tap;
    // Read from the same device we open, after explicit start/permission. A
    // missing description must not prevent capture. No device enumeration.
    let device_name = device
        .description()
        .ok()
        .map(|description| description.name().to_owned());
    device
        .build_input_stream(
            config,
            // Both the meter and the tap are allocation-free and wait-free.
            move |data: &[T], _| {
                meter.observe(data.iter().map(|sample| sample.to_sample::<f32>()));
                if let Some(tap) = tap.as_mut() {
                    tap.push_interleaved(data.iter().map(|sample| sample.to_sample::<f32>()));
                }
            },
            move |error: cpal::Error| {
                if ends_capture(error.kind()) {
                    failures.failed.store(true, Ordering::Release);
                }
            },
            Some(Duration::from_secs(2)),
        )
        .map(|stream| {
            Box::new(InputStream {
                stream,
                device_name,
            }) as Box<dyn CaptureStream>
        })
        .map_err(|_| Failure::Device)
}

#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
pub(crate) fn build_stream(
    meter: Arc<Meter>,
    tap_chunk_ms: Option<u64>,
) -> Result<(Box<dyn CaptureStream>, Option<crate::audio_tap::Chunker>), Failure> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let device = cpal::default_host()
        .default_input_device()
        .ok_or(Failure::NoDevice)?;
    let supported = device.default_input_config().map_err(|_| Failure::Device)?;
    let format = supported.sample_format();
    let config = supported.config();
    // For a live session, the callback also feeds a tap toward transcription.
    let (tap, chunker) = match tap_chunk_ms {
        Some(chunk_ms) => {
            let (tap, chunker) =
                crate::audio_tap::tap(config.sample_rate, config.channels, chunk_ms);
            (Some(tap), Some(chunker))
        }
        None => (None, None),
    };
    // Use the current default input device and its native format. No loopback,
    // device-name telemetry, file output, or automatic device switching.
    let stream = match format {
        cpal::SampleFormat::I8 => input::<i8>(&device, config, meter, tap),
        cpal::SampleFormat::I16 => input::<i16>(&device, config, meter, tap),
        cpal::SampleFormat::I24 => input::<cpal::I24>(&device, config, meter, tap),
        cpal::SampleFormat::I32 => input::<i32>(&device, config, meter, tap),
        cpal::SampleFormat::I64 => input::<i64>(&device, config, meter, tap),
        cpal::SampleFormat::U8 => input::<u8>(&device, config, meter, tap),
        cpal::SampleFormat::U16 => input::<u16>(&device, config, meter, tap),
        cpal::SampleFormat::U24 => input::<cpal::U24>(&device, config, meter, tap),
        cpal::SampleFormat::U32 => input::<u32>(&device, config, meter, tap),
        cpal::SampleFormat::U64 => input::<u64>(&device, config, meter, tap),
        cpal::SampleFormat::F32 => input::<f32>(&device, config, meter, tap),
        cpal::SampleFormat::F64 => input::<f64>(&device, config, meter, tap),
        _ => Err(Failure::Unsupported),
    }?;
    Ok((stream, chunker))
}

#[cfg(not(any(target_os = "macos", windows, target_os = "linux")))]
pub(crate) fn build_stream(
    _meter: Arc<Meter>,
    _tap_chunk_ms: Option<u64>,
) -> Result<(Box<dyn CaptureStream>, Option<crate::audio_tap::Chunker>), Failure> {
    Err(Failure::Unsupported)
}

/// Whether a stream error means the input is gone. A momentary overload
/// (`Xrun`), a refused real-time priority or a rerouted default leave the
/// stream running: ending a meeting for a glitch would lose more than the
/// glitch did. Audio that really stops is still caught by the input timeout.
#[cfg(any(target_os = "macos", windows, target_os = "linux"))]
fn ends_capture(kind: cpal::ErrorKind) -> bool {
    !matches!(
        kind,
        cpal::ErrorKind::Xrun | cpal::ErrorKind::RealtimeDenied | cpal::ErrorKind::DeviceChanged
    )
}

#[cfg(all(test, any(target_os = "macos", windows, target_os = "linux")))]
mod tests {
    use super::ends_capture;
    use cpal::ErrorKind;

    #[test]
    fn a_glitch_keeps_the_microphone_and_a_lost_device_ends_it() {
        for kind in [
            ErrorKind::Xrun,
            ErrorKind::RealtimeDenied,
            ErrorKind::DeviceChanged,
        ] {
            assert!(!ends_capture(kind), "{kind:?}");
        }
        for kind in [
            ErrorKind::DeviceNotAvailable,
            ErrorKind::StreamInvalidated,
            ErrorKind::PermissionDenied,
            ErrorKind::DeviceBusy,
            ErrorKind::BackendError,
            ErrorKind::Other,
        ] {
            assert!(ends_capture(kind), "{kind:?}");
        }
    }
}
