//! Selected-snapshot projections: v1 remains inert; v2 is used only by the
//! explicit API lab mode. Legacy prompt_input continues to reject prior notes.
use super::{Failure, Provenance, Request};
use serde_json::{json, Value};

pub const SELECTED_SNAPSHOT_INPUT_BYTES: usize = 16_384;
pub const SELECTED_SNAPSHOT_FRAME_BYTES: usize = 65_536;

fn selected_text(value: &str) -> bool {
    !value
        .chars()
        .any(|c| c.is_control() && c != '\n' && c != '\t')
}

impl Request {
    /// Serialize only the immutable sources the native permission bridge gave
    /// this request. Revision strings are opaque local versions, not a claim
    /// that a provider verified the snapshot as current.
    pub fn selected_snapshot_input(&self) -> Result<String, Failure> {
        self.selected_input(false)
    }

    /// API-only v2 projection; zero notes is an explicit selected-mode control.
    pub fn selected_prior_context_input(&self) -> Result<String, Failure> {
        self.selected_input(true)
    }

    fn selected_input(&self, v2: bool) -> Result<String, Failure> {
        let mut events = Vec::new();
        let mut notes = Vec::new();
        for source in &self.sources {
            if source.id.chars().any(char::is_control) || !selected_text(&source.text) {
                return Err(Failure::InvalidInput);
            }
            match &source.provenance {
                Provenance::Transcript { .. } => {
                    if source.revision != 0
                        || source
                            .id
                            .strip_prefix("transcript:")
                            .is_none_or(str::is_empty)
                    {
                        return Err(Failure::InvalidInput);
                    }
                    events.push(json!({"id":source.id,"speaker":"Speaker","text":source.text}));
                }
                Provenance::PriorNote {
                    provider,
                    date,
                    title,
                } => {
                    let prefix = format!("prior:{}:", provider.id());
                    if !selected_text(title)
                        || source
                            .id
                            .strip_prefix(prefix.as_str())
                            .is_none_or(str::is_empty)
                        || !(crate::context::valid_date(date)
                            || (v2
                                && *provider == crate::context::Provider::File
                                && date.is_empty()))
                        || source.text.chars().count() > crate::context::MAX_EXCERPT_CHARS
                    {
                        return Err(Failure::InvalidInput);
                    }
                    notes.push(json!({
                        "id":source.id,"provider":provider.id(),"title":title,"date":if date.is_empty() { Value::Null } else { json!(date) },
                        "snapshotRevision":source.revision.to_string(),
                        "freshness":"not_verified","text":source.text
                    }));
                }
            }
        }
        if events.is_empty() || (!v2 && notes.is_empty()) || notes.len() > crate::context::MAX_ITEMS
        {
            return Err(Failure::InvalidInput);
        }
        if self
            .user_name
            .as_deref()
            .is_some_and(|name| !selected_text(name))
            || self
                .earlier_cues
                .iter()
                .any(|cue| !selected_text(&cue.text))
            || self
                .existing_cue
                .as_ref()
                .is_some_and(|cue| !selected_text(&cue.text))
        {
            return Err(Failure::InvalidInput);
        }
        let cue = self.existing_cue.as_ref().map(|cue| {
            let mut value = json!({"text":cue.text,"sourceIds":cue.source_ids});
            if cue.asked {
                value["kind"] = json!("asked");
            }
            value
        });
        let mut value = json!({
            "inputContract":if v2 {"selected-prior-context-v2"} else {"selected-snapshots-v1"}, "events":events,
            "priorNotes":notes,"existingCue":cue
        });
        if let Some(name) = &self.user_name {
            value["userName"] = json!(name);
        }
        if !self.earlier_cues.is_empty() {
            value["earlierCues"] = json!(self.earlier_cues);
        }
        let text = value.to_string();
        if text.len() > SELECTED_SNAPSHOT_INPUT_BYTES {
            return Err(Failure::InvalidInput);
        }
        Ok(text)
    }

    /// Pure frame preparation for a future reviewed transport. The supplied
    /// envelope may not replace input; count all metadata plus the newline.
    /// This does not send, authorize, or register anything.
    pub fn selected_snapshot_frame(&self, mut envelope: Value) -> Result<String, Failure> {
        let fields = envelope.as_object_mut().ok_or(Failure::InvalidInput)?;
        if fields.contains_key("input") {
            return Err(Failure::InvalidInput);
        }
        fields.insert(
            "input".into(),
            serde_json::from_str(&self.selected_snapshot_input()?)
                .map_err(|_| Failure::InvalidInput)?,
        );
        let frame = envelope.to_string() + "\n";
        if frame.len() > SELECTED_SNAPSHOT_FRAME_BYTES {
            return Err(Failure::InvalidInput);
        }
        Ok(frame)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::{context::Provider, cue_evaluator::Source};

    fn request(revision: u64) -> Request {
        Request::new(
            1,
            1,
            vec![
                Source {
                    id: "transcript:current".into(),
                    revision: 0,
                    provenance: Provenance::Transcript {
                        at_ms: 10,
                        speaker: "Maya".into(),
                    },
                    text: "Can we send the pack Friday?".into(),
                },
                Source {
                    id: "prior:file:a".into(),
                    revision,
                    provenance: Provenance::PriorNote {
                        provider: Provider::File,
                        date: "2026-11-01".into(),
                        title: "Welcome pack review".into(),
                    },
                    text: "Review needs two days.".into(),
                },
            ],
            None,
        )
        .unwrap()
    }

    #[test]
    fn selected_v2_empty_control_and_exact_native_projection_preserve_v1() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../scripts/fixtures/selected-context-input.json"
        ))
        .unwrap();
        let mut r = request(u64::MAX);
        assert_eq!(
            serde_json::from_str::<Value>(&r.selected_prior_context_input().unwrap()).unwrap(),
            fixture
        );
        r.sources.pop();
        assert_eq!(r.selected_snapshot_input(), Err(Failure::InvalidInput));
        let empty: Value =
            serde_json::from_str(&r.selected_prior_context_input().unwrap()).unwrap();
        assert_eq!(empty["priorNotes"], json!([]));
        assert_eq!(empty["inputContract"], "selected-prior-context-v2");
        r.sources.clear();
        assert_eq!(r.selected_prior_context_input(), Err(Failure::InvalidInput));
    }

    #[test]
    fn selected_mode_shared_control_policy_uses_real_request_construction() {
        use crate::cue_evaluator::{CueEnd, EarlierCue, ExistingCue};
        let corpus: Value = serde_json::from_str(include_str!(
            "../../../scripts/fixtures/selected-snapshot-strings.json"
        ))
        .unwrap();
        for (group, allowed) in [("positive", true), ("negative", false)] {
            for value in corpus[group].as_array().unwrap() {
                let text = value.as_str().unwrap();
                for field in ["speech", "note", "title", "name", "earlier", "cue"] {
                    let base = request(7);
                    let mut sources = base.sources;
                    match field {
                        "speech" => sources[0].text = text.into(),
                        "note" => sources[1].text = text.into(),
                        "title" => {
                            if let Provenance::PriorNote { title, .. } = &mut sources[1].provenance
                            {
                                *title = text.into();
                            }
                        }
                        _ => {}
                    }
                    let existing = (field == "cue").then(|| ExistingCue {
                        id: "current-cue".into(),
                        text: text.into(),
                        source_ids: vec!["transcript:current".into()],
                        asked: false,
                    });
                    let constructed = Request::new(1, 1, sources, existing).and_then(|r| {
                        r.with_listener(
                            (field == "name").then(|| text.into()),
                            if field == "earlier" {
                                vec![EarlierCue {
                                    text: text.into(),
                                    state: CueEnd::Expired,
                                }]
                            } else {
                                vec![]
                            },
                        )
                    });
                    if !allowed && matches!(field, "speech" | "note") {
                        assert!(
                            constructed.is_ok(),
                            "legacy source text domain stays unchanged"
                        );
                    } else {
                        assert_eq!(constructed.is_ok(), allowed, "constructor field {field}");
                    }
                    let v2 = constructed
                        .as_ref()
                        .ok()
                        .map(|r| r.selected_prior_context_input());
                    assert_eq!(v2.is_some_and(|v| v.is_ok()), allowed, "v2 field {field}");
                    let serialized = constructed.and_then(|r| r.selected_snapshot_input());
                    assert_eq!(serialized.is_ok(), allowed, "selected field {field}");
                    if let Ok(serialized) = serialized {
                        assert!(serialized.contains("selected-snapshots-v1"));
                    }
                }
            }
        }
        for value in corpus["idNegative"].as_array().unwrap() {
            for (index, prefix) in [(0, "transcript:"), (1, "prior:file:")] {
                let mut sources = request(7).sources;
                sources[index].id = format!("{prefix}{}", value.as_str().unwrap());
                let result =
                    Request::new(1, 1, sources, None).and_then(|r| r.selected_snapshot_input());
                assert!(
                    result.is_err(),
                    "control in source identifier must never serialize"
                );
            }
        }
    }

    #[test]
    fn selected_snapshot_matches_the_shared_cross_language_fixture() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../scripts/fixtures/selected-snapshot-input.json"
        ))
        .unwrap();
        let input = request(u64::MAX).selected_snapshot_input().unwrap();
        assert_eq!(serde_json::from_str::<Value>(&input).unwrap(), fixture);
    }

    #[test]
    fn selected_snapshot_exact_serialized_byte_boundary_never_partially_sends() {
        let mut r = request(7);
        let base = r.sources.pop().unwrap();
        for n in 0..8 {
            let mut note = base.clone();
            note.id = format!("prior:file:n{n}");
            note.text = "x".repeat(1500);
            r.sources.push(note);
        }
        let size = r.selected_snapshot_input().unwrap().len();
        let mut left = SELECTED_SNAPSHOT_INPUT_BYTES - size;
        for note in &mut r.sources[1..] {
            let count = left.min(500);
            note.text.push_str(&"x".repeat(count));
            left -= count;
        }
        assert_eq!(left, 0);
        assert_eq!(
            r.selected_snapshot_input().unwrap().len(),
            SELECTED_SNAPSHOT_INPUT_BYTES
        );
        r.sources.last_mut().unwrap().text.push('x');
        assert_eq!(r.selected_snapshot_input(), Err(Failure::InvalidInput));
    }

    #[test]
    fn selected_snapshot_preserves_opaque_u64_versions_and_legacy_refusal() {
        for revision in [0, 1, (1_u64 << 53) + 1, u64::MAX] {
            let r = request(revision);
            assert_eq!(r.prompt_input(), Err(Failure::InvalidInput));
            let wire: Value = serde_json::from_str(&r.selected_snapshot_input().unwrap()).unwrap();
            assert_eq!(
                wire["priorNotes"][0]["snapshotRevision"],
                revision.to_string()
            );
            assert_eq!(wire["priorNotes"][0]["freshness"], "not_verified");
            assert_eq!(wire["events"][0]["id"], "transcript:current");
        }
    }

    #[test]
    fn selected_snapshot_rejects_wrong_namespaces_dates_and_missing_source_classes() {
        for id in ["prior:granola:a", "transcript:a", "prior:file:"] {
            let mut r = request(7);
            r.sources[1].id = id.into();
            assert_eq!(r.selected_snapshot_input(), Err(Failure::InvalidInput));
        }
        let mut r = request(7);
        r.sources[0].id = "prior:file:speech".into();
        assert_eq!(r.selected_snapshot_input(), Err(Failure::InvalidInput));
        let mut r = request(7);
        r.sources[0].revision = 1;
        assert_eq!(r.selected_snapshot_input(), Err(Failure::InvalidInput));
        let mut r = request(7);
        if let Provenance::PriorNote { date, .. } = &mut r.sources[1].provenance {
            *date = "2026-02-30".into();
        }
        assert_eq!(r.selected_snapshot_input(), Err(Failure::InvalidInput));
        for index in [0, 1] {
            let mut r = request(7);
            r.sources.remove(index);
            assert_eq!(r.selected_snapshot_input(), Err(Failure::InvalidInput));
        }
    }

    #[test]
    fn selected_snapshot_counts_utf8_escaping_and_complete_frame() {
        let mut r = request(7);
        r.sources[1].text = "🌱\\\"\n".repeat(300);
        let input = r.selected_snapshot_input().unwrap();
        assert_eq!(
            serde_json::from_str::<Value>(&input).unwrap()["priorNotes"][0]["text"],
            r.sources[1].text
        );
        let overhead = r
            .selected_snapshot_frame(json!({"padding":""}))
            .unwrap()
            .len();
        let padding = "x".repeat(SELECTED_SNAPSHOT_FRAME_BYTES - overhead);
        assert_eq!(
            r.selected_snapshot_frame(json!({"padding":padding}))
                .unwrap()
                .len(),
            SELECTED_SNAPSHOT_FRAME_BYTES
        );
        let padding = "x".repeat(SELECTED_SNAPSHOT_FRAME_BYTES - overhead + 1);
        assert_eq!(
            r.selected_snapshot_frame(json!({"padding":padding})),
            Err(Failure::InvalidInput)
        );
        assert_eq!(
            r.selected_snapshot_frame(json!({"input":{}})),
            Err(Failure::InvalidInput)
        );
        // Each Source fits independently, but the exact selection cannot fit
        // the new serialized-input policy. Never send only a prefix of notes.
        let base = r.sources[1].clone();
        for n in 0..8 {
            let mut note = base.clone();
            note.id = format!("prior:file:extra-{n}");
            r.sources.push(note);
        }
        assert_eq!(r.selected_snapshot_input(), Err(Failure::InvalidInput));
    }
}

#[cfg(test)]
mod unknown_date_projection_tests {
    use super::*;
    use crate::{context::Provider, cue_evaluator::Source};
    #[test]
    fn selected_v2_projects_unknown_file_date_as_null_but_v1_keeps_its_strict_contract() {
        let request = Request::new(
            1,
            1,
            vec![
                Source {
                    id: "transcript:current".into(),
                    revision: 0,
                    provenance: Provenance::Transcript {
                        at_ms: 1,
                        speaker: "Speaker".into(),
                    },
                    text: "Which rendering choice fits?".into(),
                },
                Source {
                    id: "prior:file:reference".into(),
                    revision: 1,
                    provenance: Provenance::PriorNote {
                        provider: Provider::File,
                        date: String::new(),
                        title: "Fictional reference".into(),
                    },
                    text: "Authored journeys.".into(),
                },
            ],
            None,
        )
        .unwrap();
        let value: Value =
            serde_json::from_str(&request.selected_prior_context_input().unwrap()).unwrap();
        assert_eq!(value["priorNotes"][0]["date"], Value::Null);
        assert_eq!(value["priorNotes"][0]["freshness"], "not_verified");
        assert_eq!(
            request.selected_snapshot_input(),
            Err(Failure::InvalidInput)
        );
    }
}
