//! Platform permission and input-stream adapter. Constructing this module does
//! not query a device or request access; only the explicit start command does.
use super::{CaptureStream, Failure, Meter};
use std::sync::Arc;

#[cfg(target_os = "macos")]
pub(super) fn request_permission(complete: impl Fn(Result<(), Failure>) + Send + Sync + 'static) {
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

#[cfg(not(target_os = "macos"))]
pub(super) fn request_permission(complete: impl Fn(Result<(), Failure>) + Send + Sync + 'static) {
    complete(Err(Failure::Unsupported));
}

#[cfg(target_os = "macos")]
impl CaptureStream for cpal::Stream {
    fn play(&self) -> Result<(), Failure> {
        cpal::traits::StreamTrait::play(self).map_err(|_| Failure::Device)
    }
}

#[cfg(target_os = "macos")]
fn input<T>(
    device: &cpal::Device,
    config: cpal::StreamConfig,
    meter: Arc<Meter>,
) -> Result<Box<dyn CaptureStream>, Failure>
where
    T: cpal::SizedSample,
    f32: cpal::FromSample<T>,
{
    use cpal::traits::DeviceTrait;
    use std::{sync::atomic::Ordering, time::Duration};
    let failures = meter.clone();
    device
        .build_input_stream(
            config,
            move |data: &[T], _| meter.observe(data.iter().map(|sample| sample.to_sample::<f32>())),
            move |_| failures.failed.store(true, Ordering::Release),
            Some(Duration::from_secs(2)),
        )
        .map(|stream| Box::new(stream) as Box<dyn CaptureStream>)
        .map_err(|_| Failure::Device)
}

#[cfg(target_os = "macos")]
pub(super) fn build_stream(meter: Arc<Meter>) -> Result<Box<dyn CaptureStream>, Failure> {
    use cpal::traits::{DeviceTrait, HostTrait};
    let device = cpal::default_host()
        .default_input_device()
        .ok_or(Failure::NoDevice)?;
    let supported = device.default_input_config().map_err(|_| Failure::Device)?;
    let format = supported.sample_format();
    let config = supported.config();
    // Use the current default input device and its native format. No loopback,
    // device-name telemetry, file output, or automatic device switching.
    match format {
        cpal::SampleFormat::I8 => input::<i8>(&device, config, meter),
        cpal::SampleFormat::I16 => input::<i16>(&device, config, meter),
        cpal::SampleFormat::I24 => input::<cpal::I24>(&device, config, meter),
        cpal::SampleFormat::I32 => input::<i32>(&device, config, meter),
        cpal::SampleFormat::I64 => input::<i64>(&device, config, meter),
        cpal::SampleFormat::U8 => input::<u8>(&device, config, meter),
        cpal::SampleFormat::U16 => input::<u16>(&device, config, meter),
        cpal::SampleFormat::U24 => input::<cpal::U24>(&device, config, meter),
        cpal::SampleFormat::U32 => input::<u32>(&device, config, meter),
        cpal::SampleFormat::U64 => input::<u64>(&device, config, meter),
        cpal::SampleFormat::F32 => input::<f32>(&device, config, meter),
        cpal::SampleFormat::F64 => input::<f64>(&device, config, meter),
        _ => Err(Failure::Unsupported),
    }
}

#[cfg(not(target_os = "macos"))]
pub(super) fn build_stream(_meter: Arc<Meter>) -> Result<Box<dyn CaptureStream>, Failure> {
    Err(Failure::Unsupported)
}
