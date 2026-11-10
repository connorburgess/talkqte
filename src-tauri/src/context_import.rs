//! A chooser keeps its source for retry and invalidates in-flight work when
//! closed, replaced, or disconnected. Network work never holds the app lock.
use crate::context::{self, ContextItem, FetchError, NoteSource, Provider};
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc,
};

pub struct PendingImport {
    source: Option<Box<dyn NoteSource + Send>>,
    cancelled: Arc<AtomicBool>,
    provider: Provider,
}

pub struct Attempt {
    source: Box<dyn NoteSource + Send>,
    cancelled: Arc<AtomicBool>,
}

impl PendingImport {
    pub fn new(source: Box<dyn NoteSource + Send>) -> Self {
        Self {
            provider: source.provider(),
            source: Some(source),
            cancelled: Arc::new(AtomicBool::new(false)),
        }
    }

    pub fn provider(&self) -> Provider {
        self.provider
    }

    pub fn start(&mut self) -> Option<Attempt> {
        Some(Attempt {
            source: self.source.take()?,
            cancelled: self.cancelled.clone(),
        })
    }

    /// Restore only to the chooser that started this attempt. A different
    /// selection must never receive a late result or the previous source.
    pub fn restore(&mut self, attempt: Attempt) -> bool {
        if !Arc::ptr_eq(&self.cancelled, &attempt.cancelled) || attempt.cancelled() {
            return false;
        }
        self.source = Some(attempt.source);
        true
    }
}

impl Drop for PendingImport {
    fn drop(&mut self) {
        self.cancelled.store(true, Ordering::Relaxed);
    }
}

impl Attempt {
    fn cancelled(&self) -> bool {
        self.cancelled.load(Ordering::Relaxed)
    }

    pub fn fetch(&mut self, ids: &[String]) -> Result<Vec<ContextItem>, FetchError> {
        let cancel = self.cancelled.clone();
        let cancelled = || cancel.load(Ordering::Relaxed);
        context::fetch_selection(self.source.as_mut(), ids, &cancelled, &mut |delay| {
            let until = std::time::Instant::now() + delay;
            while std::time::Instant::now() < until {
                if cancelled() {
                    return false;
                }
                std::thread::sleep(
                    until
                        .saturating_duration_since(std::time::Instant::now())
                        .min(std::time::Duration::from_millis(50)),
                );
            }
            !cancelled()
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::{Capabilities, SourceError};

    struct Source(bool);
    impl NoteSource for Source {
        fn provider(&self) -> Provider {
            Provider::Granola
        }
        fn capabilities(&self) -> Capabilities {
            Capabilities {
                import_notes: true,
                ..Capabilities::default()
            }
        }
        fn fetch(&mut self, _: &[String]) -> Result<Vec<ContextItem>, SourceError> {
            if std::mem::replace(&mut self.0, false) {
                Err(SourceError::Unavailable)
            } else {
                Ok(vec![])
            }
        }
    }

    #[test]
    fn failed_import_can_retry_without_relisting_or_parallel_fetches() {
        let mut pending = PendingImport::new(Box::new(Source(true)));
        let mut attempt = pending.start().unwrap();
        assert!(pending.start().is_none());
        assert!(attempt.fetch(&["fictional-note".into()]).is_err());
        assert!(pending.restore(attempt));
        assert!(pending
            .start()
            .unwrap()
            .fetch(&["fictional-note".into()])
            .is_ok());
    }

    #[test]
    fn closing_or_replacing_a_chooser_discards_its_late_result() {
        let mut pending = PendingImport::new(Box::new(Source(false)));
        let mut attempt = pending.start().unwrap();
        // Even a successful fetch may arrive after the user closes.
        assert!(attempt.fetch(&[]).is_ok());
        drop(pending);
        assert_eq!(attempt.fetch(&[]), Err(FetchError::Cancelled));
        let mut replacement = PendingImport::new(Box::new(Source(false)));
        assert!(!replacement.restore(attempt));
        assert!(replacement.start().is_some());
    }
}
