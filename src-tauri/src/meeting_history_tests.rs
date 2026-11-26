//! Every test uses its own temporary folder; none touches the real
//! Application Support directory. All content is fictional.

use super::*;

struct Folder(PathBuf);

impl Folder {
    fn new(name: &str) -> Self {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let path = std::env::temp_dir().join(format!(
            "talkqte-history-{name}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        let _ = fs::remove_dir_all(&path);
        Self(path)
    }

    fn root(&self) -> PathBuf {
        self.0.join(DIR)
    }

    fn store(&self) -> Store {
        Store::open(Some(self.root()), false)
    }
}

impl Drop for Folder {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

fn content(started_at_ms: u64, line: &str) -> Content {
    Content {
        started_at_ms,
        duration_ms: 1_800_000,
        sources: Sources::Microphone,
        application: None,
        transcribed_by: Some("Deepgram".into()),
        transcript: vec![Line {
            at_ms: 4_000,
            label: None,
            echo: false,
            text: line.into(),
        }],
        notes: "Bring the fictional ladder.".into(),
        cues: vec![Cue {
            at_ms: 5_000,
            kind: "Timing".into(),
            question: "What date should we aim for?".into(),
            evidence: line.into(),
        }],
        meeting_notes: Some("## Decisions\n\n- Review takes two days.".into()),
    }
}

#[test]
fn a_kept_meeting_is_listed_opened_renamed_and_deleted_for_good() {
    let folder = Folder::new("round-trip");
    let store = folder.store();
    assert_eq!(store.list(None).meetings, vec![]);
    let kept = store
        .keep(
            "Orchard  planning\n",
            content(1_000, "Legal said review takes two days."),
        )
        .unwrap();
    assert!(valid_id(&kept.id));
    assert_eq!(kept.title, "Orchard planning", "spaces are tidied");
    assert!(kept.has_meeting_notes);

    let opened = store.open_meeting(&kept.id).unwrap();
    assert_eq!(
        opened.content,
        content(1_000, "Legal said review takes two days.")
    );

    let renamed = store.rename(&kept.id, "Orchard review").unwrap();
    assert_eq!(renamed.revision, 2);
    assert_eq!(store.list(None).meetings[0].title, "Orchard review");
    assert_eq!(
        store.open_meeting(&kept.id).unwrap().title,
        "Orchard review"
    );

    store.delete(&kept.id).unwrap();
    assert!(store.list(None).meetings.is_empty());
    assert!(!folder.root().join(&kept.id).exists(), "its folder is gone");
    assert_eq!(store.open_meeting(&kept.id), Err(Error::Missing));
}

#[test]
fn the_list_is_newest_first_and_search_matches_every_word_in_title_or_text() {
    let folder = Folder::new("search");
    let store = folder.store();
    let older = store
        .keep("Gate sign", content(1_000, "The sign costs less."))
        .unwrap();
    let newer = store
        .keep(
            "Compost rota",
            content(2_000, "Legal said review takes two days."),
        )
        .unwrap();
    let ids = |listing: Listing| {
        listing
            .meetings
            .into_iter()
            .map(|m| m.id)
            .collect::<Vec<_>>()
    };
    assert_eq!(
        ids(store.list(None)),
        vec![newer.id.clone(), older.id.clone()]
    );
    assert_eq!(
        ids(store.list(Some("REVIEW legal"))),
        vec![newer.id.clone()]
    );
    assert_eq!(ids(store.list(Some("gate"))), vec![older.id.clone()]);
    // Notes, cues and meeting notes are searched too.
    assert_eq!(ids(store.list(Some("ladder"))).len(), 2);
    assert!(ids(store.list(Some("orchard"))).is_empty());
    assert_eq!(
        ids(store.list(Some("   "))).len(),
        2,
        "a blank query lists all"
    );
}

#[cfg(unix)]
#[test]
fn files_and_folders_are_owner_only_and_no_temporary_file_is_left() {
    use std::os::unix::fs::PermissionsExt;
    let folder = Folder::new("modes");
    let store = folder.store();
    let kept = store.keep("Fictional sync", content(1, "Hello.")).unwrap();
    let mode = |path: &Path| fs::metadata(path).unwrap().permissions().mode() & 0o777;
    assert_eq!(mode(&folder.root()), 0o700);
    assert_eq!(mode(&folder.root().join(&kept.id)), 0o700);
    assert_eq!(mode(&folder.root().join(INDEX)), 0o600);
    assert_eq!(mode(&folder.root().join(&kept.id).join(MEETING)), 0o600);
    let names: Vec<_> = fs::read_dir(folder.root().join(&kept.id))
        .unwrap()
        .map(|entry| entry.unwrap().file_name())
        .collect();
    assert_eq!(names, vec![std::ffi::OsString::from(MEETING)]);
}

#[test]
fn a_stored_meeting_holds_no_audio_key_name_or_focus_fields() {
    let folder = Folder::new("fields");
    let store = folder.store();
    let kept = store.keep("Fictional sync", content(1, "Hello.")).unwrap();
    let value: Value =
        serde_json::from_slice(&fs::read(folder.root().join(&kept.id).join(MEETING)).unwrap())
            .unwrap();
    let keys: std::collections::BTreeSet<_> = value
        .as_object()
        .unwrap()
        .keys()
        .map(String::as_str)
        .collect();
    assert_eq!(
        keys,
        [
            "cues",
            "durationMs",
            "id",
            "meetingNotes",
            "notes",
            "revision",
            "sources",
            "startedAtMs",
            "title",
            "transcribedBy",
            "transcript",
            "version",
        ]
        .into_iter()
        .collect()
    );
}

#[test]
fn a_newer_history_is_read_only_and_never_overwritten_until_delete_all() {
    let folder = Folder::new("newer");
    let store = folder.store();
    let kept = store.keep("Fictional sync", content(1, "Hello.")).unwrap();
    let index = folder.root().join(INDEX);
    let newer = br#"{"version": 2, "meetings": [], "somethingNew": true}"#;
    fs::write(&index, newer).unwrap();

    let listing = store.list(None);
    assert_eq!(listing.availability, Availability::Newer);
    assert!(listing.meetings.is_empty());
    assert_eq!(store.keep("Another", content(2, "Hi.")), Err(Error::Newer));
    assert_eq!(store.rename(&kept.id, "Renamed"), Err(Error::Newer));
    assert_eq!(store.delete(&kept.id), Err(Error::Newer));
    assert_eq!(fs::read(&index).unwrap(), newer, "left exactly as it was");

    store.delete_all().unwrap();
    assert!(!folder.root().exists());
    assert_eq!(store.list(None).availability, Availability::On);
    assert!(store.keep("Fresh", content(3, "Hi.")).is_ok());
}

#[test]
fn a_newer_meeting_file_is_not_shown_or_changed() {
    let folder = Folder::new("newer-meeting");
    let store = folder.store();
    let kept = store.keep("Fictional sync", content(1, "Hello.")).unwrap();
    let path = folder.root().join(&kept.id).join(MEETING);
    let newer = format!(r#"{{"version": 9, "id": "{}"}}"#, kept.id);
    fs::write(&path, &newer).unwrap();
    let listing = store.list(None);
    assert!(listing.meetings.is_empty());
    assert_eq!(listing.unreadable, 1);
    assert_eq!(store.open_meeting(&kept.id), Err(Error::Newer));
    assert_eq!(store.rename(&kept.id, "Renamed"), Err(Error::Newer));
    assert_eq!(fs::read_to_string(&path).unwrap(), newer);
}

#[test]
fn damaged_oversized_or_out_of_bounds_files_are_not_shown_and_never_replaced() {
    let folder = Folder::new("damaged");
    let store = folder.store();
    let good = store.keep("Good", content(2, "Fine.")).unwrap();
    let bad = store.keep("Bad", content(1, "Fine.")).unwrap();
    let bad_path = folder.root().join(&bad.id).join(MEETING);
    let cases: Vec<Vec<u8>> = vec![
        b"not json".to_vec(),
        br#"{"id": "x"}"#.to_vec(),
        // Version-less: its fields may mean something else.
        serde_json::to_vec(&serde_json::json!({"id": bad.id, "title": "Bad"})).unwrap(),
        // A line beyond the bound.
        {
            let mut long = content(1, &"a".repeat(MAX_LINE_CHARS + 1));
            long.cues.clear();
            render(&MeetingFileOut {
                version: VERSION,
                meeting: &Meeting {
                    id: bad.id.clone(),
                    title: "Bad".into(),
                    revision: 1,
                    folder: None,
                    content: long,
                },
            })
        },
        // Another meeting's file under this id.
        render(&MeetingFileOut {
            version: VERSION,
            meeting: &store.open_meeting(&good.id).unwrap(),
        }),
        // A control character in the title.
        render(&MeetingFileOut {
            version: VERSION,
            meeting: &Meeting {
                id: bad.id.clone(),
                title: "Bad\u{7}".into(),
                revision: 1,
                folder: None,
                content: content(1, "Fine."),
            },
        }),
    ];
    for bytes in cases {
        fs::write(&bad_path, &bytes).unwrap();
        let listing = store.list(None);
        assert_eq!(
            listing
                .meetings
                .iter()
                .map(|m| m.id.as_str())
                .collect::<Vec<_>>(),
            vec![good.id.as_str()]
        );
        assert_eq!(listing.unreadable, 1);
        assert_eq!(store.open_meeting(&bad.id), Err(Error::Unreadable));
        assert_eq!(store.rename(&bad.id, "Renamed"), Err(Error::Unreadable));
        assert_eq!(fs::read(&bad_path).unwrap(), bytes, "never rewritten");
    }
    // Oversized: not read at all.
    let file = fs::File::create(&bad_path).unwrap();
    file.set_len(MAX_MEETING_BYTES + 1).unwrap();
    assert_eq!(store.list(None).unreadable, 1);
    // A deleted meeting can still be removed by itself.
    store.delete(&bad.id).unwrap();
    assert_eq!(store.list(None).unreadable, 0);

    // A damaged index is not replaced by a keep.
    let index = folder.root().join(INDEX);
    fs::write(&index, b"{broken").unwrap();
    assert_eq!(store.keep("New", content(3, "Hi.")), Err(Error::Unreadable));
    assert_eq!(fs::read(&index).unwrap(), b"{broken");
    assert_eq!(store.list(None).unreadable, 1);
    assert_eq!(store.delete_all(), Ok(0));
    assert!(!folder.root().exists());
}

#[test]
fn ids_and_titles_are_checked_before_any_path_or_write() {
    let folder = Folder::new("ids");
    let store = folder.store();
    for id in [
        "",
        "../index",
        "ABCDEF0123456789abcdef0123456789",
        "a/b",
        &"a".repeat(33),
    ] {
        assert!(!valid_id(id));
        assert_eq!(store.open_meeting(id), Err(Error::Missing));
        assert_eq!(store.delete(id), Err(Error::Missing));
    }
    assert_eq!(store.keep("   ", content(1, "Hi.")), Err(Error::Title));
    assert_eq!(
        store.keep(&"t".repeat(MAX_TITLE_CHARS + 1), content(1, "Hi.")),
        Err(Error::Title)
    );
    assert!(!folder.root().exists(), "nothing was written");
}

#[test]
fn out_of_bounds_content_and_a_full_history_are_refused() {
    let folder = Folder::new("bounds");
    let store = folder.store();
    let mut long_notes = content(1, "Hi.");
    long_notes.notes = "n".repeat(MAX_NOTES_CHARS + 1);
    assert_eq!(store.keep("Long", long_notes), Err(Error::Invalid));
    let mut labelled = content(1, "Hi.");
    labelled.transcript[0].label = Some(Label::Them);
    assert_eq!(
        store.keep("Labels without both sources", labelled),
        Err(Error::Invalid)
    );
    let mut named = content(1, "Hi.");
    named.application = Some("Fictional Call".into());
    assert_eq!(
        store.keep("A name for a microphone meeting", named),
        Err(Error::Invalid)
    );

    // A full index refuses another meeting rather than dropping one.
    let entries: Vec<Summary> = (0..MAX_MEETINGS)
        .map(|n| Summary {
            id: format!("{n:032x}"),
            title: "Fictional".into(),
            revision: 1,
            started_at_ms: n as u64,
            duration_ms: 0,
            sources: Sources::Microphone,
            has_meeting_notes: false,
            folder: None,
        })
        .collect();
    Store::write_index(&folder.root(), &entries, &[]).unwrap();
    assert_eq!(store.keep("One more", content(1, "Hi.")), Err(Error::Full));
}

#[test]
fn an_update_replaces_content_and_keeps_the_title() {
    let folder = Folder::new("update");
    let store = folder.store();
    let kept = store.keep("Fictional sync", content(1, "Hello.")).unwrap();
    let mut later = content(1, "Hello.");
    later.notes = "Added after the meeting.".into();
    let updated = store.update(&kept.id, later.clone()).unwrap();
    assert_eq!(updated.title, "Fictional sync");
    assert_eq!(updated.revision, 2);
    assert_eq!(store.open_meeting(&kept.id).unwrap().content, later);
}

#[test]
fn a_lab_run_or_a_launch_without_a_folder_reads_and_writes_nothing() {
    let folder = Folder::new("lab");
    let person = folder.store();
    person
        .keep("The person's meeting", content(1, "Hello."))
        .unwrap();
    let before = fs::read(folder.root().join(INDEX)).unwrap();

    let lab = Store::open(Some(folder.root()), true);
    assert_eq!(lab.availability(), Availability::LabRun);
    let listing = lab.list(None);
    assert_eq!(listing.availability, Availability::LabRun);
    assert!(listing.meetings.is_empty(), "the lab never sees them");
    assert_eq!(lab.keep("Lab take", content(2, "Hi.")), Err(Error::Off));
    assert_eq!(lab.delete_all(), Err(Error::Off));
    assert_eq!(fs::read(folder.root().join(INDEX)).unwrap(), before);

    let nowhere = Store::open(None, false);
    assert_eq!(nowhere.availability(), Availability::Unavailable);
    assert_eq!(nowhere.keep("Anything", content(1, "Hi.")), Err(Error::Off));
}

#[test]
fn every_lab_launch_setting_turns_the_history_off() {
    for name in crate::settings::LAB_SETTINGS {
        assert!(
            crate::settings::lab_run_in(|present| present == *name),
            "{name}"
        );
    }
    assert!(!crate::settings::lab_run_in(|_| false));
}

/// A fixed version-1 file, so a later format has to read or migrate it.
#[test]
fn a_version_one_meeting_file_is_read() {
    let folder = Folder::new("fixture");
    let store = folder.store();
    let id = "0123456789abcdef0123456789abcdef";
    owner_only_dir(&folder.root().join(id)).unwrap();
    fs::write(
        folder.root().join(INDEX),
        format!(
            r#"{{"version":1,"meetings":[{{"id":"{id}","title":"Fictional planning","revision":1,"startedAtMs":1795000000000,"durationMs":60000,"sources":"both"}}]}}"#
        ),
    )
    .unwrap();
    fs::write(
        folder.root().join(id).join(MEETING),
        format!(
            r#"{{"version":1,"id":"{id}","title":"Fictional planning","revision":1,"startedAtMs":1795000000000,"durationMs":60000,"sources":"both","transcript":[{{"atMs":1000,"label":"you","text":"I can bring the ladder."}},{{"atMs":2000,"label":"you","echo":true,"text":"Thanks."}},{{"atMs":2100,"label":"them","text":"Thanks."}}],"notes":"","cues":[]}}"#
        ),
    )
    .unwrap();
    let listing = store.list(None);
    assert_eq!(listing.meetings.len(), 1);
    assert!(!listing.meetings[0].has_meeting_notes);
    let meeting = store.open_meeting(id).unwrap();
    assert_eq!(meeting.content.sources, Sources::Both);
    assert!(meeting.content.transcript[1].echo);
    assert_eq!(meeting.content.transcript[2].label, Some(Label::Them));
}

#[test]
fn a_kept_meeting_exports_notes_cues_and_transcript_without_unkept_fields() {
    let folder = Folder::new("export");
    let store = folder.store();
    let mut both = content(1_795_000_000_000, "Legal said review takes two days.");
    both.sources = Sources::Both;
    both.transcript = vec![
        Line {
            at_ms: 4_000,
            label: Some(Label::You),
            echo: false,
            text: "Can we ship Friday?".into(),
        },
        Line {
            at_ms: 5_000,
            label: Some(Label::You),
            echo: true,
            text: "Legal said review takes two days.".into(),
        },
        Line {
            at_ms: 5_100,
            label: Some(Label::Them),
            echo: false,
            text: "Legal said review takes two days.".into(),
        },
    ];
    let kept = store.keep("Orchard review", both).unwrap();
    let markdown = store.open_meeting(&kept.id).unwrap().markdown();
    assert!(markdown.starts_with("# Orchard review\n\n"));
    assert!(markdown.contains("Length 30:00 · Microphone and application"));
    assert!(!markdown.contains("Fictional Call"));
    assert!(markdown.contains("Bring the fictional ladder."));
    assert!(markdown.contains("## Decisions\n\n- Review takes two days."));
    assert!(markdown.contains("- 00:05 · Timing: What date should we aim for?"));
    assert!(markdown.contains("Transcribed by Deepgram. Speakers are not identified."));
    assert!(markdown.contains("the application's audio"));
    assert!(markdown.contains("- 00:04 You: Can we ship Friday?"));
    assert!(markdown
        .contains("- 00:05 You (likely an echo of Them): Legal said review takes two days."));
    assert!(markdown.contains("- 00:05 Them: Legal said review takes two days."));

    let mut named = content(1_795_000_000_000, "Hello.");
    named.sources = Sources::Both;
    named.application = Some("Fictional Call".into());
    named.transcript[0].label = Some(Label::Them);
    let named_summary = store.keep("Named call", named).unwrap();
    let named_md = store.open_meeting(&named_summary.id).unwrap().markdown();
    assert!(named_md.contains("Microphone and Fictional Call"));
    assert!(named_md.contains("Fictional Call's audio"));
}

#[test]
fn a_kept_meeting_context_item_sends_notes_and_meeting_notes_only_never_transcript() {
    use crate::context::{NoteSource, Provider, MAX_EXCERPT_CHARS};
    let folder = Folder::new("context");
    let store = folder.store();

    let with_notes = store
        .keep(
            "Orchard planning",
            content(1_795_000_000_000, "Secret transcript sentence."),
        )
        .unwrap();
    let mut empty_notes = content(1_795_000_100_000, "Another transcript line.");
    empty_notes.notes = "   ".into();
    empty_notes.meeting_notes = None;
    let _without_notes = store.keep("Empty notes", empty_notes).unwrap();

    let mut long_notes = content(1_795_000_200_000, "Transcript omitted.");
    long_notes.notes = "a".repeat(MAX_EXCERPT_CHARS + 500);
    long_notes.meeting_notes = None;
    let bounded = store.keep("Long notes", long_notes).unwrap();

    let mut source = HistorySource::read(&store).unwrap();
    assert_eq!(source.provider(), Provider::History);
    assert_eq!(source.skipped, 1, "meeting without notes is skipped");
    let summaries = source.summaries();
    assert_eq!(summaries.len(), 2);
    assert_eq!(summaries[0].source_id, bounded.id);
    assert_eq!(summaries[1].source_id, with_notes.id);

    let fetched = source.fetch(std::slice::from_ref(&with_notes.id)).unwrap();
    assert_eq!(fetched.len(), 1);
    let item = &fetched[0];
    assert_eq!(item.provider, Provider::History);
    assert_eq!(item.revision, 1);
    assert!(item.excerpt.contains("Meeting notes:"));
    assert!(item.excerpt.contains("Review takes two days."));
    assert!(item.excerpt.contains("Your notes:"));
    assert!(item.excerpt.contains("Bring the fictional ladder."));
    assert!(!item.excerpt.contains("Secret transcript sentence."));
    assert!(!item.excerpt.contains("What date should we aim for?"));

    let bounded_item = source.fetch(&[bounded.id]).unwrap();
    assert_eq!(bounded_item[0].excerpt.chars().count(), MAX_EXCERPT_CHARS);

    let lab = Store::open(Some(folder.root()), true);
    assert!(matches!(HistorySource::read(&lab), Err(Error::Off)));
}

#[test]
fn folders_can_be_created_assigned_renamed_searched_and_deleted_without_losing_meetings() {
    let folder = Folder::new("folders");
    let store = folder.store();

    let first = store
        .keep("Orchard sync", content(1_000, "Gate bolts need checking."))
        .unwrap();
    let second = store
        .keep(
            "Compost planning",
            content(2_000, "Legal said review takes two days."),
        )
        .unwrap();
    assert_eq!(first.folder, None);
    assert_eq!(second.folder, None);

    // Validation and duplicate checks.
    assert_eq!(store.create_folder("   "), Err(Error::Folder));
    assert_eq!(
        store.create_folder(&"f".repeat(MAX_FOLDER_CHARS + 1)),
        Err(Error::Folder)
    );
    assert_eq!(store.create_folder("Client\u{7}"), Err(Error::Folder));
    assert_eq!(store.create_folder("Client\u{202E}A"), Err(Error::Folder));

    assert_eq!(
        store.create_folder("  Client   A \n").unwrap(),
        vec!["Client A"]
    );
    assert_eq!(store.create_folder("client a"), Err(Error::FolderExists));
    assert_eq!(
        store.create_folder("Project B").unwrap(),
        vec!["Client A", "Project B"]
    );

    // Assigning to a missing folder is refused.
    assert_eq!(
        store.set_folder(&first.id, Some("Missing")),
        Err(Error::FolderMissing)
    );

    // Assign first meeting to Client A (case-insensitive match stores canonical name).
    let moved = store.set_folder(&first.id, Some("client a")).unwrap();
    assert_eq!(moved.folder.as_deref(), Some("Client A"));
    assert_eq!(moved.revision, 2);
    assert_eq!(
        store.open_meeting(&first.id).unwrap().folder.as_deref(),
        Some("Client A")
    );

    // Updating content preserves the folder assignment.
    let mut updated_content = content(1_000, "Gate bolts need checking.");
    updated_content.notes = "Updated notes inside folder.".into();
    let updated = store.update(&first.id, updated_content).unwrap();
    assert_eq!(updated.folder.as_deref(), Some("Client A"));

    // Search filters across unfiled and foldered meetings, and matches folder name.
    let listing = store.list(None);
    assert_eq!(listing.folders, vec!["Client A", "Project B"]);
    assert_eq!(listing.meetings.len(), 2);
    assert_eq!(store.list(Some("Client A")).meetings.len(), 1);
    assert_eq!(store.list(Some("Client A")).meetings[0].id, first.id);
    assert_eq!(store.list(Some("ladder")).meetings.len(), 2);

    // Renaming a folder updates all meetings inside it and prevents collisions.
    assert_eq!(
        store.rename_folder("Client A", "project b"),
        Err(Error::FolderExists)
    );
    assert_eq!(
        store.rename_folder("Missing", "Other"),
        Err(Error::FolderMissing)
    );
    assert_eq!(
        store.rename_folder("Client A", "Client Alpha").unwrap(),
        vec!["Client Alpha", "Project B"]
    );
    assert_eq!(
        store.open_meeting(&first.id).unwrap().folder.as_deref(),
        Some("Client Alpha")
    );
    assert_eq!(store.open_meeting(&second.id).unwrap().folder, None);

    // Deleting a folder moves its meetings back to unfiled (None) and never deletes them.
    assert_eq!(
        store.delete_folder("Client Alpha").unwrap(),
        vec!["Project B"]
    );
    assert_eq!(store.open_meeting(&first.id).unwrap().folder, None);
    let after_delete = store.list(None);
    assert_eq!(after_delete.folders, vec!["Project B"]);
    assert_eq!(after_delete.meetings.len(), 2);

    // Assigning and explicitly unfiling back to None works.
    store.set_folder(&second.id, Some("Project B")).unwrap();
    let unfiled = store.set_folder(&second.id, None).unwrap();
    assert_eq!(unfiled.folder, None);

    // Lab runs neither read nor modify folders.
    let lab = Store::open(Some(folder.root()), true);
    assert!(lab.list(None).folders.is_empty());
    assert_eq!(lab.create_folder("Lab folder"), Err(Error::Off));
    assert_eq!(lab.rename_folder("Project B", "Lab"), Err(Error::Off));
    assert_eq!(lab.delete_folder("Project B"), Err(Error::Off));
    assert_eq!(
        lab.set_folder(&first.id, Some("Project B")),
        Err(Error::Off)
    );
    assert_eq!(store.list(None).folders, vec!["Project B"]);
}

#[test]
fn newer_history_and_invalid_folder_fields_are_handled_safely() {
    let folder = Folder::new("folder-safety");
    let store = folder.store();
    store.create_folder("Client A").unwrap();
    let kept = store.keep("Fictional sync", content(1, "Hello.")).unwrap();
    store.set_folder(&kept.id, Some("Client A")).unwrap();

    // A meeting file with an out-of-bounds folder name is marked unreadable and untouched.
    let meeting_path = folder.root().join(&kept.id).join(MEETING);
    let mut bad_meeting = store.open_meeting(&kept.id).unwrap();
    bad_meeting.folder = Some("x".repeat(MAX_FOLDER_CHARS + 1));
    let bad_bytes = render(&MeetingFileOut {
        version: VERSION,
        meeting: &bad_meeting,
    });
    fs::write(&meeting_path, &bad_bytes).unwrap();
    let listing = store.list(None);
    assert_eq!(listing.unreadable, 1);
    assert!(listing.meetings.is_empty());
    assert_eq!(fs::read(&meeting_path).unwrap(), bad_bytes);

    // Newer index version blocks folder mutations without overwriting index.json.
    let index_path = folder.root().join(INDEX);
    let newer = br#"{"version": 2, "meetings": [], "folders": ["Future"]}"#;
    fs::write(&index_path, newer).unwrap();
    assert_eq!(store.create_folder("Client B"), Err(Error::Newer));
    assert_eq!(store.rename_folder("Future", "Renamed"), Err(Error::Newer));
    assert_eq!(store.delete_folder("Future"), Err(Error::Newer));
    assert_eq!(fs::read(&index_path).unwrap(), newer);
}
