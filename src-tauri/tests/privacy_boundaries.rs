//! Privacy promises the code keeps, checked from outside the crate: which
//! commands the companion window may call and what it receives, what the
//! webview may contact, what an export can contain, and what a Granola
//! request carries. Every value here is fictional.

use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    io::{Read, Write},
    net::TcpListener,
    path::Path,
    sync::{Arc, Mutex},
};
use talkqte_lib::{
    context::{ContextItem, Provider},
    engine::{Engine, Segment},
    granola::{Connection, Tokens},
};

fn manifest_json(relative: &str) -> Value {
    let path = Path::new(env!("CARGO_MANIFEST_DIR")).join(relative);
    serde_json::from_str(&std::fs::read_to_string(path).expect("readable configuration"))
        .expect("valid JSON")
}

fn strings(value: &Value) -> BTreeSet<String> {
    value
        .as_array()
        .expect("a list")
        .iter()
        .map(|entry| entry.as_str().expect("a string").to_string())
        .collect()
}

fn keys(value: &Value) -> BTreeSet<String> {
    value
        .as_object()
        .expect("an object")
        .keys()
        .cloned()
        .collect()
}

fn set(names: &[&str]) -> BTreeSet<String> {
    names.iter().map(|name| name.to_string()).collect()
}

fn line(id: &str, at_ms: u64, text: &str) -> Segment {
    Segment {
        id: id.into(),
        at_ms,
        speaker: "Speaker".into(),
        text: text.into(),
    }
}

fn imported_note() -> ContextItem {
    ContextItem {
        provider: Provider::File,
        source_id: "compost-1".into(),
        title: "Compost rota handover".into(),
        source_date: "2026-11-02".into(),
        excerpt: "Priya keeps the padlock code for the bins.".into(),
        revision: 1,
    }
}

#[test]
fn the_companion_window_cannot_export_edit_import_connect_or_start_capture() {
    let cue = manifest_json("capabilities/cue.json");
    let main = manifest_json("capabilities/main.json");
    assert_eq!(strings(&cue["windows"]), set(&["cue"]));
    assert_eq!(strings(&main["windows"]), set(&["main"]));
    let cue = strings(&cue["permissions"]);
    let main = strings(&main["permissions"]);

    // What the notebook alone may do. Each must exist for the notebook, so a
    // renamed command cannot make this check pass by matching nothing.
    let notebook_only = set(&[
        "allow-export-preview",
        "allow-export-markdown",
        "allow-update-notes",
        "allow-set-user-name",
        "allow-set-focus",
        "allow-start-microphone",
        "allow-start-live-session",
        "allow-pick-context-file",
        "allow-import-context-notes",
        "allow-context-items",
        "allow-remove-context-item",
        "allow-remove-context-from",
        "allow-connect-granola",
        "allow-granola-status",
        "allow-list-granola-notes",
        "allow-suggest-granola-focus",
        "allow-disconnect-granola",
        "allow-download-model",
        "allow-remove-model",
        "allow-review-processing-scope",
        "allow-approve-processing-scope",
        "allow-processing-snapshot",
    ]);
    assert!(
        notebook_only.is_subset(&main),
        "not granted to the notebook: {:?}",
        notebook_only.difference(&main).collect::<Vec<_>>()
    );
    assert!(
        cue.is_disjoint(&notebook_only),
        "the companion gained: {:?}",
        cue.intersection(&notebook_only).collect::<Vec<_>>()
    );

    // Everything the companion may do: read and dismiss the cue, keep the
    // quoted line it shows, pause, hide, move, and stop. A new entry is a
    // privacy decision to make here and in PRIVACY.md, not a default.
    let companion = set(&[
        "core:event:allow-listen",
        "core:event:allow-unlisten",
        "core:window:allow-start-dragging",
        "allow-snapshot",
        "allow-respond-to-cue",
        "allow-keep-line",
        "allow-inspect-cue",
        "allow-set-overlay",
        "allow-set-sensitivity",
        "allow-pause-demo",
        "allow-resume-demo",
        "allow-set-live-cues-paused",
        "allow-microphone-snapshot",
        "allow-stop-microphone",
        "allow-stop-live-session",
    ]);
    assert!(
        cue.is_subset(&companion),
        "the companion gained: {:?}",
        cue.difference(&companion).collect::<Vec<_>>()
    );
}

#[test]
fn the_webview_may_connect_only_to_the_apps_own_ipc() {
    let config = manifest_json("tauri.conf.json");
    let sources = |policy: &str, directive: &str| -> Vec<String> {
        config["app"]["security"][policy]
            .as_str()
            .expect("a content security policy")
            .split(';')
            .map(|part| part.split_whitespace().collect::<Vec<_>>())
            .find(|part| part.first() == Some(&directive))
            .map(|part| part[1..].iter().map(|source| source.to_string()).collect())
            .unwrap_or_default()
    };
    // The interface cannot send notes, transcript, or a name anywhere but
    // the app's own process, and cannot load script from elsewhere.
    assert_eq!(
        sources("csp", "connect-src"),
        ["ipc:", "http://ipc.localhost"]
    );
    for directive in ["default-src", "script-src", "font-src"] {
        assert_eq!(sources("csp", directive), ["'self'"], "{directive}");
    }
    assert_eq!(sources("csp", "form-action"), ["'none'"]);
    assert_eq!(sources("csp", "frame-src"), ["'none'"]);
    // Development adds the loopback dev server and nothing else.
    assert_eq!(
        sources("devCsp", "connect-src"),
        [
            "ipc:",
            "http://ipc.localhost",
            "http://127.0.0.1:1420",
            "ws://127.0.0.1:1420"
        ]
    );
    assert_eq!(sources("devCsp", "script-src"), ["'self'"]);
}

#[test]
fn the_companion_receives_the_cue_and_display_state_but_no_notebook_content() {
    let mut engine = Engine::live();
    engine.set_user_name(Some("Marisol".into())).unwrap();
    engine
        .set_focus(vec!["Agree the seating chart for the potluck".into()])
        .unwrap();
    engine
        .update_notes("A notebook line about the seed budget.".into())
        .unwrap();
    engine.set_notes(vec![imported_note()]);
    engine.start().unwrap();
    engine.advance(2_000);
    let session = engine.session();
    engine
        .ingest(
            session,
            line("l1", 1_000, "The greenhouse keys are in the blue tin."),
        )
        .unwrap();
    engine
        .ingest(
            session,
            line("l2", 2_000, "Someone should send the checklist."),
        )
        .unwrap();
    assert_eq!(engine.state.transcript.len(), 2);

    let payload = serde_json::to_value(engine.cue_snapshot()).unwrap();
    assert_eq!(
        keys(&payload),
        set(&[
            "revision",
            "status",
            "live",
            "cuesPaused",
            "cue",
            "overlayEnabled",
            "companionPosition",
            "questionSize",
            "sensitivity",
        ])
    );
    let cue = &payload["cue"];
    assert_eq!(cue["question"], "Who will take the first draft?");
    assert_eq!(cue["sourceId"], "l2");
    assert_eq!(cue["evidence"], "Someone should send the checklist.");
    assert!(keys(cue).is_subset(&set(&[
        "id",
        "kind",
        "question",
        "evidence",
        "sources",
        "sourceId",
        "remainingMs",
        "totalMs",
        "held",
        "expanded",
        "resolvedBy",
        "note",
        "aboutFocus",
    ])));
    // Only the line the question came from: not the rest of the transcript,
    // the notebook, the name, the focus lines, or an unrelated imported note.
    let sent = payload.to_string();
    for private in [
        "blue tin",
        "seed budget",
        "Marisol",
        "seating chart",
        "Compost rota",
        "padlock code",
        "compost-1",
    ] {
        assert!(!sent.contains(private), "the companion received {private}");
    }
    // The notebook window does hold them, so the check above is not vacuous.
    let notebook = serde_json::to_string(&engine.state).unwrap();
    for held in ["blue tin", "seed budget", "Marisol", "seating chart"] {
        assert!(notebook.contains(held), "the notebook lost {held}");
    }
}

#[test]
fn an_export_holds_notes_and_the_demo_transcript_but_no_name_focus_or_imported_note() {
    let mut engine = Engine::default();
    engine.set_user_name(Some("Marisol".into())).unwrap();
    engine
        .set_focus(vec!["Agree the seating chart for the potluck".into()])
        .unwrap();
    engine
        .update_notes("A notebook line about the seed budget.".into())
        .unwrap();
    engine.set_notes(vec![imported_note()]);
    engine.start().unwrap();
    engine.advance(60_000);
    assert!(!engine.state.transcript.is_empty());

    let export = engine.markdown();
    assert!(export.contains("A notebook line about the seed budget."));
    assert!(export.contains("Fictional demo transcript; not derived from microphone audio."));
    assert!(export.contains(&engine.state.transcript[0].text));
    for private in [
        "Marisol",
        "seating chart",
        "Compost rota",
        "padlock code",
        "compost-1",
    ] {
        assert!(!export.contains(private), "the export contains {private}");
    }
}

#[test]
fn file_and_model_errors_name_no_path_and_quote_no_file_content() {
    use talkqte_lib::{model, notes_file::FileSource};
    let folder = std::env::temp_dir().join(format!("talkqte-allotment-{}", std::process::id()));
    std::fs::create_dir_all(&folder).unwrap();
    let notes = folder.join("committee-notes.json");
    let model_file = folder.join("ggml-tiny.en.bin");
    let mut messages = vec![
        FileSource::read(&notes).unwrap_err(),
        model::verify(&model_file, &model::TINY_EN).unwrap_err(),
    ];
    for content in [
        "Priya keeps the padlock code for the bins.",
        r#"{"notes": [{"id": "n1", "text": "Priya keeps the padlock code for the bins."}]}"#,
        r#"{"notes": []}"#,
    ] {
        std::fs::write(&notes, content).unwrap();
        messages.push(FileSource::read(&notes).unwrap_err());
    }
    std::fs::write(&model_file, "Priya keeps the padlock code for the bins.").unwrap();
    messages.push(model::verify(&model_file, &model::TINY_EN).unwrap_err());
    messages.push(model::Failure::Storage(folder.display().to_string()).message());
    let _ = std::fs::remove_dir_all(&folder);

    assert_eq!(messages.len(), 7);
    for message in &messages {
        assert!(message.ends_with('.') && message.chars().count() <= 120);
        for private in [
            "allotment",
            "committee",
            "ggml",
            "Priya",
            "padlock",
            "n1",
            "/",
            "\\",
        ] {
            assert!(!message.contains(private), "{message}");
        }
    }
}

/// The requests a fictional server saw: each one's head and body.
type Seen = Arc<Mutex<Vec<(String, String)>>>;

/// A fictional MCP server on a loopback port that answers the handshake and
/// records each request.
fn fictional_mcp_server() -> (String, Seen) {
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
    let seen = Arc::new(Mutex::new(Vec::new()));
    let log = seen.clone();
    std::thread::spawn(move || {
        for stream in listener.incoming() {
            let Ok(mut stream) = stream else { break };
            let mut received = Vec::new();
            let mut buffer = [0u8; 8192];
            let (head, body) = loop {
                let read = stream.read(&mut buffer).unwrap_or(0);
                received.extend_from_slice(&buffer[..read]);
                let text = String::from_utf8_lossy(&received).into_owned();
                if let Some((head, body)) = text.split_once("\r\n\r\n") {
                    let length = head
                        .lines()
                        .find_map(|line| {
                            line.to_lowercase()
                                .strip_prefix("content-length:")
                                .and_then(|value| value.trim().parse::<usize>().ok())
                        })
                        .unwrap_or(0);
                    if body.len() >= length {
                        break (head.to_string(), body.to_string());
                    }
                }
                if read == 0 {
                    break (text, String::new());
                }
            };
            let request: Value = serde_json::from_str(&body).unwrap_or(Value::Null);
            log.lock().unwrap().push((head, body));
            let result = match request["method"].as_str() {
                Some("initialize") => json!({"protocolVersion": "2025-06-18", "capabilities": {}}),
                Some("tools/list") => json!({"tools": []}),
                _ => Value::Null,
            };
            let (status, reply) = if result.is_null() {
                ("202 Accepted", String::new())
            } else {
                (
                    "200 OK",
                    json!({"jsonrpc": "2.0", "id": request["id"], "result": result}).to_string(),
                )
            };
            let _ = stream.write_all(
                format!(
                    "HTTP/1.1 {status}\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                    reply.len()
                )
                .as_bytes(),
            );
        }
    });
    (endpoint, seen)
}

#[test]
fn granola_requests_name_the_app_and_carry_the_token_only_as_a_bearer_header() {
    let (endpoint, seen) = fictional_mcp_server();
    let tokens = Tokens {
        access_token: "fictional-access-token".into(),
    };
    let connection = Connection::open_at(&endpoint, &tokens, false).unwrap();
    let seen = seen.lock().unwrap().clone();
    // initialize, the initialized notification, tools/list.
    assert_eq!(seen.len(), 3);
    for (head, body) in &seen {
        let header = |name: &str| -> Vec<String> {
            head.lines()
                .skip(1)
                .filter_map(|line| line.split_once(':'))
                .filter(|(key, _)| key.eq_ignore_ascii_case(name))
                .map(|(_, value)| value.trim().to_string())
                .collect()
        };
        assert_eq!(header("user-agent"), ["TalkQTE"]);
        assert_eq!(header("authorization"), ["Bearer fictional-access-token"]);
        assert!(header("cookie").is_empty());
        // Never in the address or the body, where a server or proxy log keeps it.
        assert!(!head
            .lines()
            .next()
            .unwrap()
            .contains("fictional-access-token"));
        assert!(!body.contains("fictional-access-token"));
    }
    // Debug output is what a panic message or a stray log line would print.
    let debug = format!("{tokens:?} {connection:?}");
    assert!(!debug.contains("fictional-access-token"), "{debug}");
}
