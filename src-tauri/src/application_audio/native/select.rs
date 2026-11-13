//! One-shot enumeration of applications that can be selected. Calling it can
//! show the macOS Screen Recording permission prompt, so the host must have
//! disclosed the application-wide scope first. No test calls this, and it has
//! not been run on a device.

use super::{stream::Selection, Failure};
use block2::RcBlock;
use objc2::rc::Retained;
use objc2_foundation::NSError;
use objc2_screen_capture_kit::{SCShareableContent, SCStreamErrorCode, SCStreamErrorDomain};
use std::{
    sync::{
        atomic::{AtomicBool, Ordering},
        mpsc::{sync_channel, RecvTimeoutError},
    },
    time::Duration,
};

/// One retain of the listed content while it crosses from the framework's
/// queue to the worker. Dropping it anywhere, including inside a channel
/// nobody reads any more, gives the retain back.
struct Handoff(usize);

impl Handoff {
    fn keep(content: Retained<SCShareableContent>) -> Self {
        Self(Retained::into_raw(content) as usize)
    }

    fn take(self) -> Option<Retained<SCShareableContent>> {
        let address = self.0;
        std::mem::forget(self);
        // SAFETY: the address came from into_raw in `keep` and is taken once.
        unsafe { Retained::from_raw(address as *mut SCShareableContent) }
    }
}

impl Drop for Handoff {
    fn drop(&mut self) {
        // SAFETY: as in `take`; this is the only other way out.
        drop(unsafe { Retained::from_raw(self.0 as *mut SCShareableContent) });
    }
}

/// Ask ScreenCaptureKit for the shareable content once and retain each listed
/// application, with the first display, as a `Selection` on this thread.
/// Waits for the completion, which the OS may hold while its own prompt is
/// open; `cancelled` ends the wait within about 100 ms and a late answer is
/// released unused. Applications whose names cannot be shown safely are
/// omitted. Nothing is captured and no stream is created.
///
/// # Safety
/// Call on the dedicated worker that will own the selections, never the UI
/// thread or an audio callback, and only after the person acknowledged the
/// disclosed scope. The content object is created on a framework queue and
/// handed to this thread once, by ownership of one retain; that transfer and
/// the permission behavior need device validation.
pub unsafe fn shareable_applications(cancelled: &AtomicBool) -> Result<Vec<Selection>, Failure> {
    if !objc2::available!(macos = 14.0) {
        return Err(Failure::Unavailable);
    }
    let (answer, answered) = sync_channel::<Result<Handoff, Failure>>(1);
    let completion = RcBlock::new(
        move |content: *mut SCShareableContent, error: *mut NSError| {
            // SAFETY: the framework passes a valid object or null for each.
            // Only the borrowed error's domain and code are read.
            let outcome = match (unsafe { error.as_ref() }, unsafe {
                Retained::retain(content)
            }) {
                (None, Some(content)) => Ok(Handoff::keep(content)),
                (Some(error), _)
                    if error.code() == SCStreamErrorCode::UserDeclined.0
                        && error
                            .domain()
                            .isEqualToString(unsafe { SCStreamErrorDomain }) =>
                {
                    Err(Failure::PermissionDenied)
                }
                _ => Err(Failure::Unavailable),
            };
            // If nobody is waiting any more, the unsent handoff is dropped
            // here and releases its retain.
            let _ = answer.try_send(outcome);
        },
    );
    // SAFETY: the OS floor was checked; the block owns only a channel end.
    unsafe { SCShareableContent::getShareableContentWithCompletionHandler(&completion) };
    let content = loop {
        match answered.recv_timeout(Duration::from_millis(100)) {
            Ok(Ok(handoff)) => break handoff.take().ok_or(Failure::Unavailable)?,
            Ok(Err(failure)) => return Err(failure),
            Err(RecvTimeoutError::Timeout) if cancelled.load(Ordering::Acquire) => {
                return Err(Failure::Cancelled);
            }
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => return Err(Failure::Unavailable),
        }
    };
    // SAFETY: plain property reads of the retained content on this thread.
    let (displays, applications) = unsafe { (content.displays(), content.applications()) };
    let display = displays.firstObject().ok_or(Failure::SourceUnavailable)?;
    Ok(applications
        .to_vec()
        .into_iter()
        .filter_map(|application| Selection::new(display.clone(), application).ok())
        .collect())
}
