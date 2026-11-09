//! Granola as a note source, through its MCP server. The person signs in
//! with their own Granola account in the browser (OAuth 2.0 with PKCE and
//! dynamic client registration, as Granola's MCP page describes); the app
//! then lists their recent notes and fetches only the ones they tick. Tokens
//! live in memory for this app session, nothing is written to disk, and
//! nothing is sent to Granola but the sign-in and the two tool calls.
//!
//! What Granola's tools return is read defensively: the shape of a note is
//! taken from the fields the response carries, so an account check can
//! confirm the mapping before anything depends on it.

use crate::context::{
    Capabilities, ContextItem, NoteSource, Provider, SourceError, MAX_EXCERPT_CHARS,
    MAX_TITLE_CHARS,
};
use crate::notes_file::{NoteSummary, MAX_NOTES};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{Arc, Mutex},
    time::{Duration, Instant},
};

/// Granola's MCP server, from its documentation and its published
/// protected-resource metadata.
pub const RESOURCE: &str = "https://mcp.granola.ai/mcp";
/// The MCP protocol revision this client speaks.
const PROTOCOL_VERSION: &str = "2025-06-18";
const CLIENT_NAME: &str = "TalkQTE";
/// How long a sign-in may wait for the browser.
const SIGN_IN_WAIT: Duration = Duration::from_secs(300);
/// The wait a rate limit implies when the server gives no figure.
const DEFAULT_RETRY_AFTER: Duration = Duration::from_secs(30);
/// Characters of each note shown while choosing.
const PREVIEW_CHARS: usize = 120;

/// The tokens a sign-in produced. Kept in memory only.
#[derive(Clone)]
pub struct Tokens {
    pub access_token: String,
}

impl std::fmt::Debug for Tokens {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("Tokens(redacted)")
    }
}

fn agent(https_only: bool) -> ureq::Agent {
    ureq::Agent::config_builder()
        .timeout_resolve(Some(Duration::from_secs(15)))
        .timeout_connect(Some(Duration::from_secs(15)))
        .timeout_send_request(Some(Duration::from_secs(15)))
        .timeout_recv_response(Some(Duration::from_secs(30)))
        .timeout_recv_body(Some(Duration::from_secs(30)))
        .https_only(https_only)
        .http_status_as_error(false)
        .build()
        .into()
}

fn base64url(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let b = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let n = (u32::from(b[0]) << 16) | (u32::from(b[1]) << 8) | u32::from(b[2]);
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(TABLE[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(TABLE[n as usize & 63] as char);
        }
    }
    out
}

fn random_bytes(len: usize) -> Result<Vec<u8>, String> {
    let mut bytes = vec![0u8; len];
    getrandom::fill(&mut bytes).map_err(|_| "No randomness is available.".to_string())?;
    Ok(bytes)
}

/// A PKCE verifier and its S256 challenge.
pub fn pkce_pair() -> Result<(String, String), String> {
    let verifier = base64url(&random_bytes(32)?);
    Ok((verifier.clone(), pkce_challenge(&verifier)))
}

fn pkce_challenge(verifier: &str) -> String {
    base64url(&Sha256::digest(verifier.as_bytes()))
}

fn percent_encode(value: &str) -> String {
    let mut out = String::new();
    for byte in value.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'_' | b'.' | b'~' => {
                out.push(byte as char)
            }
            _ => out.push_str(&format!("%{byte:02X}")),
        }
    }
    out
}

fn form(pairs: &[(&str, &str)]) -> String {
    pairs
        .iter()
        .map(|(key, value)| format!("{}={}", percent_encode(key), percent_encode(value)))
        .collect::<Vec<_>>()
        .join("&")
}

/// The URL that asks the person to sign in and consent.
pub fn authorize_url(
    endpoint: &str,
    client_id: &str,
    redirect_uri: &str,
    challenge: &str,
    state: &str,
) -> String {
    format!(
        "{endpoint}?{}",
        form(&[
            ("response_type", "code"),
            ("client_id", client_id),
            ("redirect_uri", redirect_uri),
            ("code_challenge", challenge),
            ("code_challenge_method", "S256"),
            ("state", state),
            ("scope", "mcp"),
            ("resource", RESOURCE),
        ])
    )
}

/// What the browser's return request carried. Only the request line is read.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Callback {
    pub code: Option<String>,
    pub state: Option<String>,
    pub error: Option<String>,
}

/// The parts of the sign-in return, or `None` for any other request.
pub fn parse_callback(request_line: &str) -> Option<Callback> {
    let path = request_line
        .strip_prefix("GET ")
        .and_then(|rest| rest.split(' ').next())?;
    if path != "/callback" && !path.starts_with("/callback?") {
        return None;
    }
    let query = path.split_once('?').map(|(_, query)| query).unwrap_or("");
    let mut callback = Callback::default();
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode(value);
        match key {
            "code" => callback.code = Some(value),
            "state" => callback.state = Some(value),
            "error" => callback.error = Some(value),
            _ => {}
        }
    }
    Some(callback)
}

fn percent_decode(value: &str) -> String {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let decoded = (bytes[i] == b'%' && i + 2 < bytes.len())
            .then(|| std::str::from_utf8(&bytes[i + 1..i + 3]).ok())
            .flatten()
            .and_then(|hex| u8::from_str_radix(hex, 16).ok());
        match decoded {
            Some(byte) => {
                out.push(byte);
                i += 3;
            }
            None => {
                out.push(if bytes[i] == b'+' { b' ' } else { bytes[i] });
                i += 1;
            }
        }
    }
    String::from_utf8_lossy(&out).into_owned()
}

/// Signs in with the person's own Granola account: discovers the
/// authorization server from the resource's metadata, registers this app as
/// a client, opens the browser through `open_url`, waits for the return on a
/// loopback port, and exchanges the code. `cancelled` is polled while
/// waiting. Nothing is stored; the tokens are returned to the caller.
pub fn sign_in(
    open_url: &dyn Fn(&str) -> Result<(), String>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Tokens, String> {
    let agent = agent(true);
    let origin = RESOURCE
        .strip_suffix("/mcp")
        .ok_or("The Granola endpoint is not as expected.")?;
    let resource_metadata: Value = get_json(
        &agent,
        &format!("{origin}/.well-known/oauth-protected-resource"),
    )?;
    let authorization_server = resource_metadata["authorization_servers"][0]
        .as_str()
        .ok_or("Granola did not name an authorization server.")?
        .trim_end_matches('/')
        .to_string();
    // Only Granola's own hosts may sign the person in or receive the code.
    if !granola_host(&authorization_server) {
        return Err("Granola named a sign-in server outside granola.ai; stopping.".into());
    }
    let server: Value = get_json(
        &agent,
        &well_known(&authorization_server, "oauth-authorization-server")
            .ok_or("Granola's sign-in server address is not as expected.")?,
    )?;
    if server["issuer"]
        .as_str()
        .map(|issuer| issuer.trim_end_matches('/'))
        != Some(authorization_server.as_str())
    {
        return Err("Granola's sign-in metadata does not match its server.".into());
    }
    let endpoint = |name: &str| -> Result<String, String> {
        server[name]
            .as_str()
            .filter(|url| granola_host(url))
            .map(str::to_string)
            .ok_or_else(|| format!("Granola's sign-in metadata has no {name} on granola.ai."))
    };
    let (authorization_endpoint, token_endpoint, registration_endpoint) = (
        endpoint("authorization_endpoint")?,
        endpoint("token_endpoint")?,
        endpoint("registration_endpoint")?,
    );
    let listener = TcpListener::bind("127.0.0.1:0")
        .map_err(|_| "No local port is available for the sign-in.")?;
    listener
        .set_nonblocking(true)
        .map_err(|_| "The local sign-in port could not be prepared.")?;
    let port = listener
        .local_addr()
        .map_err(|_| "The local sign-in port could not be read.")?
        .port();
    let redirect_uri = format!("http://127.0.0.1:{port}/callback");
    let registration = agent
        .post(&registration_endpoint)
        .header("Accept", "application/json")
        .send_json(json!({
            "client_name": CLIENT_NAME,
            "redirect_uris": [redirect_uri],
            "grant_types": ["authorization_code"],
            "response_types": ["code"],
            "token_endpoint_auth_method": "none",
        }))
        .map_err(|_| "Granola's sign-in service could not be reached.")?;
    let registration = read_json(registration)
        .map_err(|_| "Granola did not accept this app as a client.".to_string())?;
    let client_id = registration["client_id"]
        .as_str()
        .ok_or("Granola did not return a client id.")?
        .to_string();
    let (verifier, challenge) = pkce_pair()?;
    let state = base64url(&random_bytes(16)?);
    open_url(&authorize_url(
        &authorization_endpoint,
        &client_id,
        &redirect_uri,
        &challenge,
        &state,
    ))?;
    let code = wait_for_callback(&listener, &state, cancelled)?;
    let token = agent
        .post(&token_endpoint)
        .header("Accept", "application/json")
        .header("Content-Type", "application/x-www-form-urlencoded")
        .send(form(&[
            ("grant_type", "authorization_code"),
            ("code", &code),
            ("redirect_uri", &redirect_uri),
            ("client_id", &client_id),
            ("code_verifier", &verifier),
            ("resource", RESOURCE),
        ]))
        .map_err(|_| "Granola's sign-in service could not be reached.")?;
    let token =
        read_json(token).map_err(|_| "Granola did not complete the sign-in.".to_string())?;
    let access_token = token["access_token"]
        .as_str()
        .filter(|token| !token.is_empty())
        .ok_or("Granola did not return an access token.")?
        .to_string();
    Ok(Tokens { access_token })
}

/// Whether a URL is https on granola.ai or one of its subdomains.
fn granola_host(url: &str) -> bool {
    url.strip_prefix("https://")
        .and_then(|rest| rest.split(['/', '?', '#']).next())
        // Credentials in the authority are never expected; refuse them.
        .filter(|authority| !authority.contains('@'))
        .map(|host| host.split(':').next().unwrap_or(host).to_lowercase())
        .is_some_and(|host| host == "granola.ai" || host.ends_with(".granola.ai"))
}

/// The well-known document for an issuer: after the host and before any
/// path the issuer carries, as RFC 8414 describes.
fn well_known(issuer: &str, suffix: &str) -> Option<String> {
    let rest = issuer.strip_prefix("https://")?;
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let path = path.trim_matches('/');
    Some(if path.is_empty() {
        format!("https://{host}/.well-known/{suffix}")
    } else {
        format!("https://{host}/.well-known/{suffix}/{path}")
    })
}

fn get_json(agent: &ureq::Agent, url: &str) -> Result<Value, String> {
    let response = agent
        .get(url)
        .header("Accept", "application/json")
        .call()
        .map_err(|_| "Granola could not be reached.")?;
    if response.status().as_u16() != 200 {
        return Err("Granola's sign-in metadata is unavailable.".into());
    }
    read_json(response).map_err(|_| "Granola's sign-in metadata could not be read.".into())
}

fn read_json(mut response: ureq::http::Response<ureq::Body>) -> Result<Value, ()> {
    if !(200..300).contains(&response.status().as_u16()) {
        return Err(());
    }
    let text = response
        .body_mut()
        .with_config()
        .limit(1 << 20)
        .read_to_string()
        .map_err(|_| ())?;
    serde_json::from_str(&text).map_err(|_| ())
}

/// Waits for the browser to return to the loopback port with the code for
/// this request, replying with a short page. Other requests (a favicon, a
/// probe, a return whose state is not ours) are answered and ignored, so a
/// stray local request cannot end the sign-in.
fn wait_for_callback(
    listener: &TcpListener,
    expected_state: &str,
    cancelled: &dyn Fn() -> bool,
) -> Result<String, String> {
    let started = Instant::now();
    loop {
        if cancelled() {
            return Err("Sign-in cancelled.".into());
        }
        if started.elapsed() > SIGN_IN_WAIT {
            return Err("The sign-in took too long; try again.".into());
        }
        match listener.accept() {
            Ok((mut stream, _)) => {
                // The accepted socket inherits the listener's non-blocking
                // mode on some platforms; the read below must wait for bytes.
                let _ = stream.set_nonblocking(false);
                if let Some(result) = answer_callback(&mut stream, expected_state) {
                    return result;
                }
            }
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                std::thread::sleep(Duration::from_millis(100));
            }
            Err(_) => return Err("The local sign-in port failed.".into()),
        }
    }
}

/// Reads one request from the browser and replies. Returns `None` for a
/// request that is not this sign-in's return.
fn answer_callback(stream: &mut TcpStream, expected_state: &str) -> Option<Result<String, String>> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buffer = [0u8; 4096];
    let read = stream.read(&mut buffer).ok()?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    let line = request.lines().next().unwrap_or("");
    let reply = |stream: &mut TcpStream, status: &str, body: &str| {
        let _ = stream.write_all(
            format!(
                "HTTP/1.1 {status}\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
                body.len()
            )
            .as_bytes(),
        );
    };
    let Some(callback) = parse_callback(line) else {
        reply(stream, "404 Not Found", "");
        return None;
    };
    if callback.state.as_deref() != Some(expected_state) {
        reply(
            stream,
            "200 OK",
            "<!doctype html><title>TalkQTE</title><p>This page is not from the current TalkQTE sign-in. You can close it.</p>",
        );
        return None;
    }
    let result = match (callback.error, callback.code) {
        (Some(error), _) => Err(if error == "access_denied" {
            "Sign-in was cancelled in the browser.".to_string()
        } else {
            "Granola refused the sign-in.".to_string()
        }),
        (None, Some(code)) if !code.is_empty() => Ok(code),
        _ => Err("The sign-in return was incomplete.".to_string()),
    };
    reply(
        stream,
        "200 OK",
        match &result {
            Ok(_) => "<!doctype html><title>TalkQTE</title><p>Signed in to Granola. You can return to TalkQTE.</p>",
            Err(_) => "<!doctype html><title>TalkQTE</title><p>Sign-in did not complete. You can return to TalkQTE.</p>",
        },
    );
    Some(result)
}

/// One of the server's tools, with the argument its schema names for a list
/// of note identifiers, if any.
#[derive(Clone, Debug, PartialEq, Eq)]
struct Tool {
    name: String,
    ids_argument: Option<String>,
}

/// An open MCP session with Granola, acting as the signed-in person.
pub struct Connection {
    agent: ureq::Agent,
    endpoint: String,
    access_token: String,
    session: Option<String>,
    next_id: u64,
    tools: Vec<Tool>,
}

#[allow(clippy::missing_fields_in_debug)]
impl std::fmt::Debug for Connection {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.debug_struct("Connection")
            .field("endpoint", &self.endpoint)
            .field("tools", &self.tools)
            .finish_non_exhaustive()
    }
}

impl Connection {
    /// Opens a session with Granola's server.
    pub fn open(tokens: &Tokens) -> Result<Self, SourceError> {
        Self::open_at(RESOURCE, tokens, true)
    }

    /// Opens a session with any MCP server; tests use a local fictional one.
    pub fn open_at(endpoint: &str, tokens: &Tokens, https_only: bool) -> Result<Self, SourceError> {
        let mut connection = Self {
            agent: agent(https_only),
            endpoint: endpoint.to_string(),
            access_token: tokens.access_token.clone(),
            session: None,
            next_id: 1,
            tools: vec![],
        };
        let initialized = connection.call(
            "initialize",
            json!({
                "protocolVersion": PROTOCOL_VERSION,
                "capabilities": {},
                "clientInfo": { "name": CLIENT_NAME, "version": env!("CARGO_PKG_VERSION") },
            }),
        )?;
        if initialized.get("protocolVersion").is_none() {
            return Err(SourceError::Unavailable);
        }
        connection.notify("notifications/initialized")?;
        let listed = connection.call("tools/list", json!({}))?;
        connection.tools = listed["tools"]
            .as_array()
            .map(|tools| tools.iter().filter_map(tool_from).collect())
            .unwrap_or_default();
        Ok(connection)
    }

    /// The tool names the server offers, for the readiness notes and the
    /// interface; never the person's data.
    pub fn tool_names(&self) -> Vec<String> {
        self.tools.iter().map(|tool| tool.name.clone()).collect()
    }

    fn tool(&self, name: &str) -> Option<&Tool> {
        self.tools.iter().find(|tool| tool.name == name)
    }

    /// Recent notes to choose from, and how many more the server listed
    /// than are shown.
    pub fn list_recent(&mut self) -> Result<(Vec<NoteSummary>, usize), SourceError> {
        if self.tool("list_meetings").is_none() {
            return Err(SourceError::Unavailable);
        }
        let result = self.call(
            "tools/call",
            json!({ "name": "list_meetings", "arguments": {} }),
        )?;
        let notes = notes_in(&tool_output(&result));
        let total = notes.len();
        let summaries: Vec<NoteSummary> = notes
            .into_iter()
            .take(MAX_NOTES)
            .map(|note| NoteSummary {
                source_id: note.id,
                title: note.title,
                source_date: note.date,
                preview: preview(&note.text),
            })
            .collect();
        let skipped = total - summaries.len();
        Ok((summaries, skipped))
    }

    fn notify(&mut self, method: &str) -> Result<(), SourceError> {
        let response = self
            .request(&json!({ "jsonrpc": "2.0", "method": method }))
            .map_err(|_| SourceError::Interrupted)?;
        match response.status().as_u16() {
            200..=299 => Ok(()),
            status => Err(status_error(status, &response)),
        }
    }

    fn call(&mut self, method: &str, params: Value) -> Result<Value, SourceError> {
        let id = self.next_id;
        self.next_id += 1;
        let response = self
            .request(&json!({ "jsonrpc": "2.0", "id": id, "method": method, "params": params }))
            .map_err(|_| SourceError::Interrupted)?;
        let status = response.status().as_u16();
        if !(200..300).contains(&status) {
            return Err(status_error(status, &response));
        }
        if let Some(session) = header(&response, "mcp-session-id") {
            self.session = Some(session);
        }
        let content_type = header(&response, "content-type").unwrap_or_default();
        let mut response = response;
        let text = response
            .body_mut()
            .with_config()
            .limit(4 << 20)
            .read_to_string()
            .map_err(|error| match error {
                // A reply that can never fit is not worth retrying.
                ureq::Error::BodyExceedsLimit(_) => SourceError::Unavailable,
                _ => SourceError::Interrupted,
            })?;
        let message = if content_type.starts_with("text/event-stream") {
            sse_message(&text, id).ok_or(SourceError::Unavailable)?
        } else {
            serde_json::from_str::<Value>(&text).map_err(|_| SourceError::Unavailable)?
        };
        if let Some(error) = message.get("error") {
            let text = error["message"].as_str().unwrap_or("").to_lowercase();
            return Err(if text.contains("unauthor") || text.contains("expired") {
                SourceError::Expired
            } else {
                SourceError::Unavailable
            });
        }
        let result = message
            .get("result")
            .cloned()
            .ok_or(SourceError::Unavailable)?;
        // A tool that reports failure in its result carries no notes.
        if result.get("isError") == Some(&Value::Bool(true)) {
            return Err(SourceError::Unavailable);
        }
        Ok(result)
    }

    fn request(&self, body: &Value) -> Result<ureq::http::Response<ureq::Body>, ureq::Error> {
        let mut request = self
            .agent
            .post(&self.endpoint)
            .header("Authorization", &format!("Bearer {}", self.access_token))
            .header("Accept", "application/json, text/event-stream")
            .header("MCP-Protocol-Version", PROTOCOL_VERSION)
            .header("User-Agent", CLIENT_NAME);
        if let Some(session) = &self.session {
            request = request.header("Mcp-Session-Id", session);
        }
        request.send_json(body)
    }
}

fn header(response: &ureq::http::Response<ureq::Body>, name: &str) -> Option<String> {
    response
        .headers()
        .get(name)
        .and_then(|value| value.to_str().ok())
        .map(str::to_owned)
}

fn status_error(status: u16, response: &ureq::http::Response<ureq::Body>) -> SourceError {
    match status {
        401 => SourceError::Expired,
        403 => SourceError::Revoked,
        429 => SourceError::RateLimited {
            retry_after: header(response, "retry-after")
                .and_then(|value| value.trim().parse::<u64>().ok())
                .map(Duration::from_secs)
                .unwrap_or(DEFAULT_RETRY_AFTER),
        },
        _ => SourceError::Unavailable,
    }
}

/// The JSON-RPC response with this id from an event stream.
fn sse_message(text: &str, id: u64) -> Option<Value> {
    let mut data = String::new();
    let mut found = None;
    for line in text.lines().chain(std::iter::once("")) {
        if let Some(rest) = line.strip_prefix("data:") {
            data.push_str(rest.trim_start());
            data.push('\n');
        } else if line.is_empty() && !data.is_empty() {
            if let Ok(value) = serde_json::from_str::<Value>(data.trim_end()) {
                if value.get("id").and_then(Value::as_u64) == Some(id) {
                    found = Some(value);
                    break;
                }
            }
            data.clear();
        }
    }
    found
}

fn tool_from(value: &Value) -> Option<Tool> {
    let name = value["name"].as_str()?.to_string();
    let properties = value["inputSchema"]["properties"].as_object();
    let ids_argument = properties.and_then(|properties| {
        ["meeting_ids", "ids", "meetingIds", "id", "meeting_id"]
            .iter()
            .find(|candidate| properties.contains_key(**candidate))
            .map(|candidate| candidate.to_string())
            .or_else(|| {
                properties
                    .iter()
                    .find(|(_, schema)| schema["type"] == "array")
                    .map(|(key, _)| key.clone())
            })
    });
    Some(Tool { name, ids_argument })
}

/// A tool result's content: structured content when the server sends it,
/// otherwise its text parts joined.
fn tool_output(result: &Value) -> Value {
    if let Some(structured) = result.get("structuredContent") {
        return structured.clone();
    }
    let text: String = result["content"]
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .filter_map(|part| part["text"].as_str())
                .collect::<Vec<_>>()
                .join("\n")
        })
        .unwrap_or_default();
    serde_json::from_str(&text).unwrap_or(Value::String(text))
}

#[derive(Debug, PartialEq, Eq)]
struct Note {
    id: String,
    title: String,
    date: String,
    text: String,
}

/// The notes in a tool's output, whatever it calls its fields: an array at
/// the root or under the first array-valued key, each with an id, a title or
/// name, a date-like field, and a text-like field.
fn notes_in(output: &Value) -> Vec<Note> {
    let array = match output {
        Value::Array(items) => Some(items),
        Value::Object(map) => ["meetings", "notes", "results", "items", "data"]
            .iter()
            .find_map(|key| map.get(*key).and_then(Value::as_array))
            .or_else(|| map.values().find_map(Value::as_array)),
        _ => None,
    };
    array
        .map(|items| items.iter().filter_map(note_from).collect())
        .unwrap_or_default()
}

fn note_from(value: &Value) -> Option<Note> {
    let pick = |keys: &[&str]| {
        keys.iter()
            .find_map(|key| value.get(*key))
            .and_then(|found| match found {
                Value::String(text) => Some(text.clone()),
                Value::Number(number) => Some(number.to_string()),
                _ => None,
            })
    };
    let id = pick(&["id", "meeting_id", "meetingId", "_id"])?;
    if id.trim().is_empty() {
        return None;
    }
    let title = pick(&["title", "name", "subject"])
        .map(|title| title.trim().to_string())
        .filter(|title| !title.is_empty())
        .unwrap_or_else(|| "Untitled note".into());
    let date = pick(&[
        "date",
        "created_at",
        "createdAt",
        "start_time",
        "startTime",
        "updated_at",
        "updatedAt",
    ])
    .map(|date| date.chars().take(10).collect::<String>())
    .unwrap_or_default();
    let text = pick(&[
        "notes_markdown",
        "notes",
        "summary",
        "overview",
        "content",
        "text",
        "notes_plain",
    ])
    .unwrap_or_default();
    Some(Note {
        id: id.trim().to_string(),
        title: title.chars().take(MAX_TITLE_CHARS).collect(),
        date,
        text,
    })
}

fn preview(text: &str) -> String {
    let trimmed = text.trim();
    let short: String = trimmed.chars().take(PREVIEW_CHARS).collect();
    if trimmed.chars().count() > PREVIEW_CHARS {
        format!("{short}…")
    } else {
        short
    }
}

/// One session shared by the notebook's connection and the pending import
/// it fills, so request ids and the server's session id stay one sequence.
#[derive(Clone, Debug)]
pub struct Shared(Arc<Mutex<Connection>>);

impl Shared {
    pub fn new(connection: Connection) -> Self {
        Self(Arc::new(Mutex::new(connection)))
    }

    pub fn tool_names(&self) -> Vec<String> {
        self.0
            .lock()
            .map(|connection| connection.tool_names())
            .unwrap_or_default()
    }

    pub fn list_recent(&self) -> Result<(Vec<NoteSummary>, usize), SourceError> {
        self.0
            .lock()
            .map_err(|_| SourceError::Unavailable)?
            .list_recent()
    }
}

impl NoteSource for Shared {
    fn provider(&self) -> Provider {
        Provider::Granola
    }

    fn capabilities(&self) -> Capabilities {
        self.0
            .lock()
            .map(|connection| connection.capabilities())
            .unwrap_or_default()
    }

    fn fetch(&mut self, selection: &[String]) -> Result<Vec<ContextItem>, SourceError> {
        self.0
            .lock()
            .map_err(|_| SourceError::Unavailable)?
            .fetch(selection)
    }
}

impl NoteSource for Connection {
    fn provider(&self) -> Provider {
        Provider::Granola
    }

    /// Import only. Granola's page documents no live transcript stream and
    /// no writeback through MCP, and this client asks for neither.
    fn capabilities(&self) -> Capabilities {
        Capabilities {
            import_notes: self.tool("get_meetings").is_some(),
            ..Capabilities::default()
        }
    }

    fn fetch(&mut self, selection: &[String]) -> Result<Vec<ContextItem>, SourceError> {
        let tool = self
            .tool("get_meetings")
            .cloned()
            .ok_or(SourceError::Unavailable)?;
        let argument = tool.ids_argument.unwrap_or_else(|| "meeting_ids".into());
        let result = self.call(
            "tools/call",
            json!({ "name": tool.name, "arguments": { argument: selection } }),
        )?;
        Ok(notes_in(&tool_output(&result))
            .into_iter()
            .filter(|note| selection.iter().any(|wanted| wanted == &note.id))
            .map(|note| ContextItem {
                provider: Provider::Granola,
                source_id: note.id,
                title: note.title,
                source_date: note.date,
                excerpt: note.text.trim().chars().take(MAX_EXCERPT_CHARS).collect(),
                revision: 1,
            })
            .collect())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn pkce_and_the_authorize_url_follow_the_profile() {
        let (verifier, challenge) = pkce_pair().unwrap();
        assert!(verifier.len() >= 43 && verifier.len() <= 128);
        assert!(!verifier.contains(['+', '/', '=']));
        assert_eq!(challenge, pkce_challenge(&verifier));
        let url = authorize_url(
            "https://mcp-auth.example/oauth2/authorize",
            "client 1",
            "http://127.0.0.1:4242/callback",
            &challenge,
            "st/ate",
        );
        assert!(url.starts_with(
            "https://mcp-auth.example/oauth2/authorize?response_type=code&client_id=client%201&"
        ));
        assert!(url.contains("redirect_uri=http%3A%2F%2F127.0.0.1%3A4242%2Fcallback"));
        assert!(url.contains("code_challenge_method=S256"));
        assert!(url.contains("state=st%2Fate"));
        assert!(url.ends_with("&scope=mcp&resource=https%3A%2F%2Fmcp.granola.ai%2Fmcp"));
    }

    #[test]
    fn only_granola_hosts_may_sign_the_person_in() {
        assert!(granola_host("https://mcp-auth.granola.ai/oauth2/token"));
        assert!(granola_host("https://GRANOLA.AI"));
        assert!(!granola_host("http://mcp-auth.granola.ai/oauth2/token"));
        assert!(!granola_host("https://granola.ai.example.com/x"));
        assert!(!granola_host("https://example.com/?u=granola.ai"));
        assert!(!granola_host("https://evil.com@mcp-auth.granola.ai/"));
        assert!(!granola_host("https://notgranola.ai/"));
        assert_eq!(
            well_known("https://mcp-auth.granola.ai", "oauth-authorization-server").unwrap(),
            "https://mcp-auth.granola.ai/.well-known/oauth-authorization-server"
        );
        assert_eq!(
            well_known(
                "https://mcp-auth.granola.ai/tenant/a/",
                "oauth-authorization-server"
            )
            .unwrap(),
            "https://mcp-auth.granola.ai/.well-known/oauth-authorization-server/tenant/a"
        );
        assert!(well_known("http://mcp-auth.granola.ai", "x").is_none());
    }

    #[test]
    fn the_browser_return_is_read_from_its_request_line_only() {
        let callback = parse_callback("GET /callback?code=abc%20d&state=xyz HTTP/1.1").unwrap();
        assert_eq!(
            (
                callback.code.as_deref(),
                callback.state.as_deref(),
                callback.error
            ),
            (Some("abc d"), Some("xyz"), None)
        );
        assert_eq!(
            parse_callback("GET /callback?error=access_denied&state=x HTTP/1.1")
                .unwrap()
                .error
                .as_deref(),
            Some("access_denied")
        );
        assert!(parse_callback("GET /favicon.ico HTTP/1.1").is_none());
        assert!(parse_callback("POST /callback HTTP/1.1").is_none());
        assert!(parse_callback("GET /callbackx?code=1 HTTP/1.1").is_none());
    }

    #[test]
    fn the_wait_ignores_probes_and_wrong_states_and_takes_the_matching_return() {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        listener.set_nonblocking(true).unwrap();
        let address = listener.local_addr().unwrap();
        let browser = std::thread::spawn(move || {
            let mut pages = vec![];
            for path in [
                "/favicon.ico",
                "/callback?code=forged&state=wrong",
                "/callback?error=access_denied&state=wrong",
                "/callback?code=real%2Bcode&state=expected",
            ] {
                let mut stream = TcpStream::connect(address).unwrap();
                stream
                    .write_all(format!("GET {path} HTTP/1.1\r\nHost: x\r\n\r\n").as_bytes())
                    .unwrap();
                let mut reply = String::new();
                stream.read_to_string(&mut reply).unwrap();
                pages.push(reply);
            }
            pages
        });
        let code = wait_for_callback(&listener, "expected", &|| false).unwrap();
        assert_eq!(code, "real+code");
        let pages = browser.join().unwrap();
        assert!(pages[0].starts_with("HTTP/1.1 404"));
        assert!(pages[1].contains("not from the current TalkQTE sign-in"));
        assert!(pages[2].contains("not from the current TalkQTE sign-in"));
        assert!(pages[3].contains("Signed in to Granola"));
        // A cancel ends the wait without a return.
        assert!(wait_for_callback(&listener, "expected", &|| true)
            .unwrap_err()
            .contains("cancelled"));
    }

    /// How the fictional server answers: normally (as JSON or an event
    /// stream), with an HTTP status, with a JSON-RPC error, or with a tool
    /// result that reports failure.
    #[derive(Clone, Copy)]
    enum Answer {
        Json,
        EventStream,
        Status(u16),
        RpcError(&'static str),
        ToolError,
    }

    /// A fictional MCP server on a loopback port with fixed notes; it logs
    /// each request's head and body.
    /// The requests a fictional server saw: each one's head and body.
    type Seen = Arc<Mutex<Vec<(String, String)>>>;

    fn fictional_server(answer: Answer) -> (String, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let endpoint = format!("http://{}/mcp", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::new()));
        let log = seen.clone();
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buffer = vec![0u8; 65536];
                let mut read = 0;
                loop {
                    let n = stream.read(&mut buffer[read..]).unwrap_or(0);
                    read += n;
                    let text = String::from_utf8_lossy(&buffer[..read]).into_owned();
                    let complete = text.split_once("\r\n\r\n").is_some_and(|(head, body)| {
                        let length: usize = head
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|value| value.trim().parse().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        body.len() >= length
                    });
                    if n == 0 || complete {
                        break;
                    }
                }
                let text = String::from_utf8_lossy(&buffer[..read]).into_owned();
                let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
                log.lock()
                    .unwrap()
                    .push((head.to_string(), body.to_string()));
                let request: Value = serde_json::from_str(body).unwrap_or(Value::Null);
                let reply = |stream: &mut TcpStream,
                             status: u16,
                             content_type: &str,
                             body: &str,
                             extra: &str| {
                    let _ = stream.write_all(
                        format!(
                            "HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}",
                            body.len()
                        )
                        .as_bytes(),
                    );
                };
                if let Answer::Status(status) = answer {
                    reply(
                        &mut stream,
                        status,
                        "application/json",
                        "{}",
                        "Retry-After: 7\r\n",
                    );
                    continue;
                }
                let id = request["id"].clone();
                if id.is_null() {
                    reply(&mut stream, 202, "application/json", "", "");
                    continue;
                }
                if let Answer::RpcError(message) = answer {
                    let message = json!({"jsonrpc": "2.0", "id": id, "error": {"code": -32001, "message": message}});
                    reply(
                        &mut stream,
                        200,
                        "application/json",
                        &message.to_string(),
                        "",
                    );
                    continue;
                }
                let notes = json!([
                    {"id": "m1", "title": "Garden welcome guide", "created_at": "2026-10-28T10:00:00Z", "notes_markdown": "Draft a one-page guide. Robin suggested a map of the tool shed."},
                    {"id": "m2", "name": "Visitor questions", "date": "2026-11-02", "summary": "Visitors asked where to find watering cans."},
                    {"id": "", "title": "No id", "date": "2026-11-02", "summary": "dropped"}
                ]);
                let result = match request["method"].as_str() {
                    Some("initialize") => {
                        json!({"protocolVersion": "2025-06-18", "capabilities": {"tools": {}}, "serverInfo": {"name": "fictional"}})
                    }
                    Some("tools/list") => json!({"tools": [
                        {"name": "list_meetings", "inputSchema": {"type": "object", "properties": {}}},
                        {"name": "get_meetings", "inputSchema": {"type": "object", "properties": {"meeting_ids": {"type": "array", "items": {"type": "string"}}}}}
                    ]}),
                    Some("tools/call") if matches!(answer, Answer::ToolError) => {
                        json!({"isError": true, "content": [{"type": "text", "text": "Something went wrong."}]})
                    }
                    // Every note comes back whatever was asked, so the
                    // client's own selection filter is exercised.
                    Some("tools/call") => {
                        json!({"content": [{"type": "text", "text": json!({"meetings": notes}).to_string()}]})
                    }
                    _ => json!({}),
                };
                let message = json!({"jsonrpc": "2.0", "id": id, "result": result});
                if matches!(answer, Answer::EventStream) {
                    let body = format!("event: message\ndata: {message}\n\n");
                    reply(
                        &mut stream,
                        200,
                        "text/event-stream",
                        &body,
                        "Mcp-Session-Id: s-1\r\n",
                    );
                } else {
                    reply(
                        &mut stream,
                        200,
                        "application/json",
                        &message.to_string(),
                        "Mcp-Session-Id: s-1\r\n",
                    );
                }
            }
        });
        (endpoint, seen)
    }

    fn tokens() -> Tokens {
        Tokens {
            access_token: "fictional-token".into(),
        }
    }

    #[test]
    fn a_session_lists_recent_notes_and_fetches_only_the_selection() {
        for answer in [Answer::Json, Answer::EventStream] {
            let (endpoint, seen) = fictional_server(answer);
            let mut connection = Connection::open_at(&endpoint, &tokens(), false).unwrap();
            assert_eq!(connection.tool_names(), ["list_meetings", "get_meetings"]);
            assert!(connection.capabilities().import_notes);
            assert!(!connection.capabilities().live_input && !connection.capabilities().writeback);
            let (notes, skipped) = connection.list_recent().unwrap();
            assert_eq!(skipped, 0);
            assert_eq!(
                notes
                    .iter()
                    .map(|n| (
                        n.source_id.as_str(),
                        n.title.as_str(),
                        n.source_date.as_str()
                    ))
                    .collect::<Vec<_>>(),
                [
                    ("m1", "Garden welcome guide", "2026-10-28"),
                    ("m2", "Visitor questions", "2026-11-02")
                ]
            );
            let fetched = connection.fetch(&["m2".into()]).unwrap();
            assert_eq!(fetched.len(), 1, "the client keeps only the selection");
            assert_eq!(fetched[0].provider, Provider::Granola);
            assert_eq!(fetched[0].source_id, "m2");
            assert_eq!(
                fetched[0].excerpt,
                "Visitors asked where to find watering cans."
            );
            let seen = seen.lock().unwrap().clone();
            // initialize, initialized, tools/list, list_meetings, get_meetings.
            assert_eq!(seen.len(), 5);
            assert!(seen.iter().all(|(head, _)| head
                .to_lowercase()
                .contains("authorization: bearer fictional-token")));
            assert!(
                !seen[0].0.to_lowercase().contains("mcp-session-id"),
                "none before the server issues one"
            );
            assert!(seen[4].0.to_lowercase().contains("mcp-session-id: s-1"));
            let asked: Value = serde_json::from_str(&seen[4].1).unwrap();
            assert_eq!(asked["params"]["arguments"]["meeting_ids"], json!(["m2"]));
            assert!(!format!("{connection:?}").contains("fictional-token"));
        }
    }

    #[test]
    fn a_shared_session_keeps_one_sequence_of_request_ids() {
        let (endpoint, seen) = fictional_server(Answer::Json);
        let shared = Shared::new(Connection::open_at(&endpoint, &tokens(), false).unwrap());
        let mut import: Box<dyn NoteSource + Send> = Box::new(shared.clone());
        shared.list_recent().unwrap();
        import.fetch(&["m1".into()]).unwrap();
        shared.list_recent().unwrap();
        let ids: Vec<u64> = seen
            .lock()
            .unwrap()
            .iter()
            .filter_map(|(_, body)| serde_json::from_str::<Value>(body).ok()?["id"].as_u64())
            .collect();
        assert_eq!(
            ids,
            [1, 2, 3, 4, 5],
            "no id is reused across the shared session"
        );
        assert!(!format!("{shared:?}").contains("fictional-token"));
    }

    #[test]
    fn server_failures_map_to_the_contract_errors() {
        for (answer, expected) in [
            (Answer::Status(401), SourceError::Expired),
            (Answer::Status(403), SourceError::Revoked),
            (
                Answer::Status(429),
                SourceError::RateLimited {
                    retry_after: Duration::from_secs(7),
                },
            ),
            (Answer::Status(503), SourceError::Unavailable),
            (
                Answer::RpcError("Unauthorized: token expired"),
                SourceError::Expired,
            ),
            (Answer::RpcError("Internal error"), SourceError::Unavailable),
        ] {
            let (endpoint, _) = fictional_server(answer);
            assert_eq!(
                Connection::open_at(&endpoint, &tokens(), false).err(),
                Some(expected)
            );
        }
        let (endpoint, _) = fictional_server(Answer::ToolError);
        let mut connection = Connection::open_at(&endpoint, &tokens(), false).unwrap();
        assert_eq!(
            connection.list_recent().err(),
            Some(SourceError::Unavailable)
        );
        assert_eq!(
            connection.fetch(&["m1".into()]).err(),
            Some(SourceError::Unavailable)
        );
        let (endpoint, _) = fictional_server(Answer::Json);
        let mut connection = Connection::open_at(&endpoint, &tokens(), false).unwrap();
        drop(connection.tools.pop());
        assert_eq!(
            connection.fetch(&["m1".into()]).err(),
            Some(SourceError::Unavailable),
            "without get_meetings"
        );
        assert!(!connection.capabilities().import_notes);
    }

    #[test]
    fn notes_are_read_from_whatever_fields_the_server_uses() {
        let output = json!({"items": [
            {"meeting_id": 7, "subject": "  Compost budget  ", "start_time": "2026-11-05T09:30:00+07:00", "overview": "Two bins."},
            {"id": "x", "title": "", "notes": "no date"},
            {"title": "no id at all"}
        ]});
        let notes = notes_in(&output);
        assert_eq!(notes.len(), 2);
        assert_eq!(
            (
                notes[0].id.as_str(),
                notes[0].title.as_str(),
                notes[0].date.as_str(),
                notes[0].text.as_str()
            ),
            ("7", "Compost budget", "2026-11-05", "Two bins.")
        );
        assert_eq!(
            (notes[1].title.as_str(), notes[1].date.as_str()),
            ("Untitled note", "")
        );
        assert!(notes_in(&Value::String("not json".into())).is_empty());
        let text_result = json!({"content": [{"type": "text", "text": "[{\"id\": \"a\", \"title\": \"A\", \"date\": \"2026-01-01\", \"text\": \"t\"}]"}]});
        assert_eq!(notes_in(&tool_output(&text_result)).len(), 1);
    }

    #[test]
    fn an_event_stream_yields_the_reply_with_the_matching_id() {
        let text = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{}}\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"ok\":true}}\n\n";
        assert_eq!(sse_message(text, 4).unwrap()["result"]["ok"], true);
        assert!(sse_message(text, 9).is_none());
    }
}
