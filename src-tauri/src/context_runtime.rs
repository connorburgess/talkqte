//! Where the app's runtime applies the prior-note rules: which notes the
//! cue engine may quote, and how an import and a finished update check
//! change that. These are the steps the commands in `lib.rs` call, kept
//! free of any window so they can be tested as the app runs them.
use crate::context::{ContextItem, MergeOutcome, Provider};
use crate::context_refresh::{CheckError, CheckStatus, Fetched, Report, Ticket};
use crate::Runtime;

impl Runtime {
    /// Gives the engine the notes a reminder may quote, with their
    /// warnings, and the kept notes that are held back. Returns whether a
    /// visible cue changed, so both windows are told.
    pub(crate) fn sync_prior_notes(&mut self) -> bool {
        let before = self.engine.state.revision;
        self.engine.set_prior_notes(
            self.refresh.eligible(&self.context),
            self.refresh.withheld(&self.context),
        );
        self.processing_reviews.reconcile(&self.engine);
        self.engine.state.revision != before
    }

    /// Merges an import, ends the update-check findings about the notes it
    /// returned, and brings the engine up to date.
    pub(crate) fn merge_imported_notes(
        &mut self,
        provider: Provider,
        selection: &[String],
        fetched: Vec<ContextItem>,
    ) -> (MergeOutcome, bool) {
        let outcome = self
            .refresh
            .merge_import(&mut self.context, provider, selection, fetched);
        (outcome, self.sync_prior_notes())
    }

    /// Ends the update checks of a retired connection. The times it
    /// confirmed copies are forgotten, so a displayed reminder's warning
    /// may change; returns whether a visible cue changed.
    pub(crate) fn disconnect_update_checks(&mut self) -> bool {
        self.refresh.disconnect();
        self.sync_prior_notes()
    }

    /// Applies a finished update check. Unless it was retired, the engine
    /// is brought up to date even when no copy changed, because the result
    /// decides which notes may remind and with what warning. The flag is
    /// `None` when nothing needs publishing.
    pub(crate) fn finish_update_check(
        &mut self,
        ticket: &Ticket,
        result: Result<Fetched, CheckError>,
        now_ms: u64,
    ) -> (Report, Option<bool>) {
        let report = self
            .refresh
            .apply(ticket, result, &mut self.context, now_ms);
        let retired = matches!(
            report.status,
            CheckStatus::Cancelled
                | CheckStatus::Reimported
                | CheckStatus::Removed
                | CheckStatus::RemovedOrReimported
        );
        let changed = (!retired).then(|| self.sync_prior_notes());
        (report, changed)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::context::SourceError;
    use crate::context_refresh::{run, RefreshSource, Unverified};
    use crate::engine::{Engine, NoteRef, Segment};
    use std::time::Duration;

    /// 12 November 2026 09:30 UTC as a provider update time, and the named
    /// local clock for "checked at".
    const UPDATED: u64 = 1_794_562_200_000;
    const NOW: u64 = UPDATED + 86_400_000;
    const GUIDE: &str = "Let's get the welcome guide sorted before the garden day.";
    const COMPOST: &str = "Let's get the compost rota handover sorted today.";

    fn notes() -> Vec<ContextItem> {
        [
            ("n1", "Garden welcome guide"),
            ("n2", "Compost rota handover"),
        ]
        .into_iter()
        .map(|(id, title)| ContextItem {
            provider: Provider::Granola,
            source_id: id.into(),
            title: title.into(),
            source_date: "2026-11-02".into(),
            excerpt: "Robin will label the watering cans.".into(),
            revision: UPDATED,
        })
        .collect()
    }

    fn ids() -> Vec<String> {
        vec!["n1".into(), "n2".into()]
    }

    /// A fictional provider: the notes it returns and those it reports as
    /// withdrawn, or one failure.
    struct Fictional {
        reply: Result<Vec<ContextItem>, SourceError>,
        withdrawn: Vec<String>,
    }

    impl RefreshSource for Fictional {
        fn binding_supported(&self) -> bool {
            true
        }
        fn workspace(&mut self) -> Result<Option<String>, SourceError> {
            Ok(Some("garden-club".into()))
        }
        fn fetch_available(&mut self, _: &[String]) -> Result<Vec<ContextItem>, SourceError> {
            self.reply.clone()
        }
        fn withdrawn(&mut self) -> Vec<String> {
            self.withdrawn.clone()
        }
    }

    /// A runtime in a live session with both notes imported as the import
    /// command merges them.
    fn runtime() -> Runtime {
        let mut runtime = Runtime {
            engine: Engine::live(),
            ..Runtime::default()
        };
        runtime.engine.start().unwrap();
        runtime.engine.advance(10_000);
        let (outcome, _) = runtime.merge_imported_notes(Provider::Granola, &ids(), notes());
        assert_eq!(outcome.added, 2);
        runtime
    }

    /// Runs one update check as the command does: begin, request, finish.
    fn check(runtime: &mut Runtime, source: Fictional) -> (Report, Option<bool>) {
        let ticket = runtime.refresh.begin(&runtime.context).unwrap();
        let result = run(&ticket, Box::new(source), Duration::from_secs(5));
        runtime.finish_update_check(&ticket, result, NOW)
    }

    /// The reminder, if any, that the runtime's engine raises for a line.
    fn reminder(runtime: &mut Runtime, line: &str) -> Option<NoteRef> {
        let session = runtime.engine.session();
        runtime
            .engine
            .ingest(
                session,
                Segment {
                    id: "w1".into(),
                    at_ms: 9_000,
                    speaker: "Speaker 1".into(),
                    text: line.into(),
                },
            )
            .unwrap();
        runtime.engine.state.cue.clone().and_then(|cue| cue.note)
    }

    #[test]
    fn an_import_reaches_the_engine_and_a_plain_note_reminds_without_a_warning() {
        let mut runtime = runtime();
        assert_eq!(reminder(&mut runtime, COMPOST).unwrap().unconfirmed, None);
    }

    #[test]
    fn a_check_that_changes_no_copy_still_changes_what_the_engine_may_quote() {
        // The provider returns one note unchanged, omits the other, and
        // reports nothing else: the store is untouched.
        let mut runtime = runtime();
        let (report, changed) = check(
            &mut runtime,
            Fictional {
                reply: Ok(notes().into_iter().skip(1).collect()),
                withdrawn: vec![],
            },
        );
        assert!(!report.store_changed);
        assert_eq!(changed, Some(false), "no cue was showing");
        let warned = reminder(&mut runtime, GUIDE).unwrap();
        assert_eq!(
            warned.unconfirmed.map(|warning| warning.last_confirmed_ms),
            Some(None)
        );

        // Reported as withdrawn: kept in the store, out of reminders.
        let mut runtime = self::runtime();
        let (report, _) = check(
            &mut runtime,
            Fictional {
                reply: Ok(notes().into_iter().take(1).collect()),
                withdrawn: vec!["n2".into()],
            },
        );
        assert!(!report.store_changed);
        assert_eq!(runtime.context.items().len(), 2);
        assert_eq!(reminder(&mut runtime, COMPOST), None);
    }

    #[test]
    fn a_check_withdraws_a_displayed_reminder_and_reports_the_change() {
        let mut runtime = runtime();
        assert!(reminder(&mut runtime, COMPOST).is_some());
        let (_, changed) = check(
            &mut runtime,
            Fictional {
                reply: Ok(notes().into_iter().take(1).collect()),
                withdrawn: vec!["n2".into()],
            },
        );
        assert_eq!(changed, Some(true), "the windows must be told");
        assert!(runtime.engine.state.cue.is_none());
    }

    #[test]
    fn importing_a_withheld_note_again_lets_it_remind_and_an_older_reply_does_not() {
        let withheld = || {
            let mut runtime = runtime();
            let (report, _) = check(
                &mut runtime,
                Fictional {
                    reply: Err(SourceError::Revoked),
                    withdrawn: vec![],
                },
            );
            assert_eq!(report.notes[0].reason, Some(Unverified::Revoked));
            runtime
        };
        let mut runtime = withheld();
        assert_eq!(reminder(&mut runtime, COMPOST), None);

        let mut runtime = withheld();
        let mut older = notes();
        older[1].revision = UPDATED - 1;
        runtime.merge_imported_notes(Provider::Granola, &ids(), older);
        assert_eq!(reminder(&mut runtime, COMPOST), None);

        let mut runtime = withheld();
        let (outcome, _) = runtime.merge_imported_notes(Provider::Granola, &ids(), notes());
        assert_eq!(outcome.unchanged, 2);
        assert_eq!(reminder(&mut runtime, COMPOST).unwrap().unconfirmed, None);
    }

    #[test]
    fn disconnecting_updates_a_displayed_warning_and_asks_for_a_publish() {
        let mut runtime = runtime();
        check(
            &mut runtime,
            Fictional {
                reply: Ok(notes()),
                withdrawn: vec![],
            },
        );
        // n1 is confirmed at NOW, then not returned by a later check.
        check(
            &mut runtime,
            Fictional {
                reply: Ok(notes().into_iter().skip(1).collect()),
                withdrawn: vec![],
            },
        );
        let shown = reminder(&mut runtime, GUIDE).unwrap();
        assert_eq!(
            shown.unconfirmed.map(|warning| warning.last_confirmed_ms),
            Some(Some(NOW))
        );
        assert!(
            runtime.disconnect_update_checks(),
            "the windows must be told"
        );
        let note = runtime.engine.state.cue.as_ref().unwrap().note.clone();
        assert_eq!(
            note.unwrap()
                .unconfirmed
                .map(|warning| warning.last_confirmed_ms),
            Some(None)
        );
        // Nothing else to update: no publish is asked for.
        assert!(!runtime.disconnect_update_checks());
    }

    #[test]
    fn a_retired_check_changes_nothing_and_asks_for_no_publish() {
        let mut runtime = runtime();
        let ticket = runtime.refresh.begin(&runtime.context).unwrap();
        runtime.refresh.stop();
        let result = run(
            &ticket,
            Box::new(Fictional {
                reply: Err(SourceError::Revoked),
                withdrawn: vec![],
            }),
            Duration::from_secs(5),
        );
        let (report, changed) = runtime.finish_update_check(&ticket, result, NOW);
        assert_eq!((report.status, changed), (CheckStatus::Cancelled, None));
        assert!(reminder(&mut runtime, COMPOST).is_some());
    }
}
