//! What the notebook may learn about a Granola connection, and what
//! Disconnect does to a sign-in still waiting for the browser. The sign-in
//! service, the MCP server, the account and every note are fictional.

use super::*;
use crate::granola::{
    tests::{fictional_server, fictional_sign_in_service, sign_in_through, tokens, Answer},
    Connection,
};
use std::{sync::mpsc, thread, time::Duration};

/// The first line of each request a fictional server saw.
fn request_lines(seen: &granola::tests::Seen) -> Vec<String> {
    seen.lock()
        .unwrap()
        .iter()
        .map(|(head, _)| head.lines().next().unwrap_or_default().to_string())
        .collect()
}

fn status_of(status: GranolaStatus) -> serde_json::Value {
    serde_json::to_value(status).unwrap()
}

/// What the notebook receives when no connection is open.
fn disconnected() -> serde_json::Value {
    serde_json::json!({"connected": false, "tools": [], "updateCheck": false, "freshness": []})
}

#[test]
fn disconnect_cancels_a_sign_in_that_is_waiting_for_the_browser() {
    let (origin, seen) = fictional_sign_in_service();
    let mut runtime = Runtime::default();
    let cancel = runtime.begin_granola_sign_in().unwrap();

    // The real sign-in, with a browser that opens and never returns.
    let (opened, browser_opened) = mpsc::channel();
    let waiting = cancel.clone();
    let sign_in = thread::spawn(move || {
        sign_in_through(
            &origin,
            &|_| {
                opened.send(()).unwrap();
                Ok(())
            },
            &|| waiting.load(Ordering::Relaxed),
        )
        .err()
    });
    browser_opened
        .recv_timeout(Duration::from_secs(5))
        .expect("the sign-in reached the browser step");
    assert!(
        runtime.begin_granola_sign_in().is_err(),
        "one sign-in at a time"
    );

    let status = runtime.disconnect_granola();
    assert!(!status.connected);
    assert_eq!(
        sign_in.join().unwrap().as_deref(),
        Some("Sign-in cancelled."),
        "the waiting sign-in ends instead of running out its five minutes"
    );
    assert!(
        !request_lines(&seen)
            .iter()
            .any(|line| line.contains("/token")),
        "no code was exchanged for a token"
    );

    // The command then reports the cancelled result, and a new sign-in may begin.
    assert_eq!(
        runtime
            .finish_granola_sign_in(&cancel, Err("Sign-in cancelled.".into()))
            .err()
            .as_deref(),
        Some("Sign-in cancelled.")
    );
    assert!(runtime.granola.is_none());
    let next = runtime.begin_granola_sign_in().unwrap();
    assert!(!next.load(Ordering::Relaxed));
}

#[test]
fn a_connection_that_opens_after_disconnect_is_dropped_unused() {
    let (endpoint, seen) = fictional_server(Answer::Json);
    let mut runtime = Runtime::default();
    let cancel = runtime.begin_granola_sign_in().unwrap();
    // The browser had already returned when Disconnect arrived, so the
    // session opened anyway.
    let connection = Connection::open_at(&endpoint, &tokens(), false).unwrap();
    runtime.disconnect_granola();
    let sent = request_lines(&seen).len();

    assert_eq!(
        runtime
            .finish_granola_sign_in(&cancel, Ok(connection))
            .err()
            .as_deref(),
        Some("Sign-in cancelled.")
    );
    assert!(runtime.granola.is_none());
    assert_eq!(status_of(granola_status_now(&runtime)), disconnected());
    assert_eq!(request_lines(&seen).len(), sent, "nothing more was asked");
}

#[test]
fn the_notebook_learns_connection_state_and_tool_names_but_never_identity() {
    // This listing names the signed-in account and another participant.
    let (endpoint, _) = fictional_server(Answer::TaggedListing);
    let mut runtime = Runtime::default();
    let cancel = runtime.begin_granola_sign_in().unwrap();
    let connection = Connection::open_at(&endpoint, &tokens(), false).unwrap();
    runtime
        .finish_granola_sign_in(&cancel, Ok(connection))
        .unwrap();
    let (notes, _) = runtime.granola.clone().unwrap().list_recent().unwrap();

    // Connection state, tool names, whether an update check is offered,
    // and the state of kept notes (none here): nothing about the account.
    let status = status_of(granola_status_now(&runtime));
    assert_eq!(
        status,
        serde_json::json!({
            "connected": true,
            "tools": ["list_meetings", "get_meetings", "query_granola_meetings"],
            "updateCheck": false,
            "freshness": [],
        })
    );
    // Keeping a note changes neither: no check has run, and none is
    // offered for a Granola connection, which names no workspace.
    let kept = crate::context::NoteSource::fetch(
        &mut runtime.granola.clone().unwrap(),
        &["m2".to_string()],
    )
    .unwrap();
    let outcome = runtime
        .context
        .merge(context::Provider::Granola, &["m2".to_string()], kept);
    assert_eq!(outcome.added, 1);
    assert_eq!(status_of(granola_status_now(&runtime)), status);
    // What the chooser receives: titles and dates to choose by.
    let listing = serde_json::to_string(&notes).unwrap();
    assert!(listing.contains("Garden welcome guide"));
    for private in [
        "gardener@example.com",
        "robin@example.com",
        "Robin",
        "fictional-token",
    ] {
        assert!(
            !status.to_string().contains(private),
            "status has {private}"
        );
        assert!(!listing.contains(private), "the chooser received {private}");
    }

    assert_eq!(status_of(runtime.disconnect_granola()), disconnected());
}

#[test]
fn provider_failures_reach_the_notebook_as_fixed_messages() {
    for answer in [
        Answer::RpcError("Unauthorized: fictional-token expired for gardener@example.com"),
        Answer::RpcError(
            "Internal error reading /Users/gardener/notes: Visitors asked where to find watering cans.",
        ),
        Answer::ToolError,
        Answer::Status(401),
        Answer::Status(403),
        Answer::Status(429),
        Answer::Status(500),
    ] {
        let (endpoint, _) = fictional_server(answer);
        let error = match Connection::open_at(&endpoint, &tokens(), false) {
            Err(error) => error,
            Ok(mut connection) => connection.list_recent().unwrap_err(),
        };
        let message = granola_error(&error);
        assert!(message.starts_with("Granola") && message.ends_with('.'));
        assert!(message.chars().count() <= 80, "{message}");
        for private in [
            "fictional-token",
            "gardener",
            "watering cans",
            "Users",
            "127.0.0.1",
            "/",
            "\\",
            "@",
        ] {
            assert!(!message.contains(private), "{message}");
        }
    }
}

#[test]
fn a_refused_sign_in_reports_nothing_the_browser_return_carried() {
    let (origin, seen) = fictional_sign_in_service();
    // The fictional browser returns a refusal whose description names an
    // account and a token.
    let browser = |url: &str| {
        let after = |marker: &str| url.split_once(marker).unwrap().1;
        let port: String = after("redirect_uri=http%3A%2F%2F127.0.0.1%3A")
            .chars()
            .take_while(char::is_ascii_digit)
            .collect();
        let state = after("&state=").split('&').next().unwrap().to_string();
        thread::spawn(move || {
            use std::io::{Read, Write};
            let mut stream = std::net::TcpStream::connect(format!("127.0.0.1:{port}")).unwrap();
            stream
                .write_all(
                    format!(
                        "GET /callback?error=server_error&error_description=fictional-token%20for%20gardener%40example.com&state={state} HTTP/1.1\r\nHost: x\r\n\r\n"
                    )
                    .as_bytes(),
                )
                .unwrap();
            let mut page = String::new();
            let _ = stream.read_to_string(&mut page);
        });
        Ok(())
    };
    let message =
        sign_in_through(&origin, &browser, &|| false).expect_err("the sign-in is refused");
    assert_eq!(message, "Granola refused the sign-in.");
    assert!(!request_lines(&seen)
        .iter()
        .any(|line| line.contains("/token")));
}
