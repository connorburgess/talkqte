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

/// The authorization code and state from the browser's return request, or
/// the error it reported. Only the request line is read.
pub fn parse_callback(request_line: &str) -> Result<(String, String), String> {
    let path = request_line
        .strip_prefix("GET ")
        .and_then(|rest| rest.split(' ').next())
        .ok_or("The browser sent something other than the sign-in return.")?;
    let query = path.split_once('?').map(|(_, query)| query).unwrap_or("");
    let mut code = None;
    let mut state = None;
    let mut error = None;
    for pair in query.split('&') {
        let (key, value) = pair.split_once('=').unwrap_or((pair, ""));
        let value = percent_decode(value);
        match key {
            "code" => code = Some(value),
            "state" => state = Some(value),
            "error" => error = Some(value),
            _ => {}
        }
    }
    if let Some(error) = error {
        return Err(match error.as_str() {
            "access_denied" => "Sign-in was cancelled in the browser.".into(),
            _ => "Granola refused the sign-in.".into(),
        });
    }
    match (code, state) {
        (Some(code), Some(state)) if !code.is_empty() => Ok((code, state)),
        _ => Err("The sign-in return was incomplete.".into()),
    }
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
    let server: Value = get_json(
        &agent,
        &format!("{authorization_server}/.well-known/oauth-authorization-server"),
    )?;
    let endpoint = |name: &str| -> Result<String, String> {
        server[name]
            .as_str()
            .filter(|url| url.starts_with("https://"))
            .map(str::to_string)
            .ok_or_else(|| format!("Granola's sign-in metadata has no {name}."))
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
    let (code, returned_state) = wait_for_callback(&listener, cancelled)?;
    if returned_state != state {
        return Err("The sign-in return did not match this request.".into());
    }
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

/// Waits for the browser to return to the loopback port with a code, replying
/// with a short page. Other requests (a favicon, a probe) are answered and
/// ignored.
fn wait_for_callback(
    listener: &TcpListener,
    cancelled: &dyn Fn() -> bool,
) -> Result<(String, String), String> {
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
                if let Some(result) = answer_callback(&mut stream) {
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
/// request that is not the sign-in return.
fn answer_callback(stream: &mut TcpStream) -> Option<Result<(String, String), String>> {
    let _ = stream.set_read_timeout(Some(Duration::from_secs(5)));
    let mut buffer = [0u8; 4096];
    let read = stream.read(&mut buffer).ok()?;
    let request = String::from_utf8_lossy(&buffer[..read]);
    let line = request.lines().next().unwrap_or("");
    if !line.starts_with("GET /callback") {
        let _ = stream
            .write_all(b"HTTP/1.1 404 Not Found\r\nConnection: close\r\nContent-Length: 0\r\n\r\n");
        return None;
    }
    let result = parse_callback(line);
    let body = match &result {
        Ok(_) => "<!doctype html><title>TalkQTE</title><p>Signed in to Granola. You can return to TalkQTE.</p>",
        Err(_) => "<!doctype html><title>TalkQTE</title><p>Sign-in did not complete. You can return to TalkQTE.</p>",
    };
    let _ = stream.write_all(
        format!(
            "HTTP/1.1 200 OK\r\nContent-Type: text/html; charset=utf-8\r\nConnection: close\r\nContent-Length: {}\r\n\r\n{body}",
            body.len()
        )
        .as_bytes(),
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
#[derive(Clone)]
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
            .map_err(|_| SourceError::Interrupted)?;
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
        message
            .get("result")
            .cloned()
            .ok_or(SourceError::Unavailable)
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
    use std::sync::{Arc, Mutex};

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
    fn the_browser_return_is_read_from_its_request_line_only() {
        assert_eq!(
            parse_callback("GET /callback?code=abc%20d&state=xyz HTTP/1.1").unwrap(),
            ("abc d".to_string(), "xyz".to_string())
        );
        assert!(
            parse_callback("GET /callback?error=access_denied&state=x HTTP/1.1")
                .unwrap_err()
                .contains("cancelled")
        );
        assert!(parse_callback("GET /callback?state=x HTTP/1.1").is_err());
        assert!(parse_callback("POST /callback HTTP/1.1").is_err());
    }

    /// A fictional MCP server on a loopback port: fixed notes, and a status
    /// to answer with instead when a test asks for a failure.
    fn fictional_server(status: Option<u16>, sse: bool) -> (String, Arc<Mutex<Vec<String>>>) {
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
                    if n == 0 || text.contains("\r\n\r\n") {
                        let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
                        let length: usize = head
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if body.len() >= length {
                            break;
                        }
                    }
                }
                let text = String::from_utf8_lossy(&buffer[..read]).into_owned();
                let (head, body) = text.split_once("\r\n\r\n").unwrap_or((&text, ""));
                log.lock().unwrap().push(head.to_string());
                let request: Value = serde_json::from_str(body).unwrap_or(Value::Null);
                let reply = |stream: &mut TcpStream,
                             status: u16,
                             content_type: &str,
                             body: &str,
                             extra: &str| {
                    let _ = stream.write_all(format!("HTTP/1.1 {status} X\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n{extra}\r\n{body}", body.len()).as_bytes());
                };
                if let Some(status) = status {
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
                    Some("tools/call") => {
                        let wanted = request["params"]["arguments"]["meeting_ids"]
                            .as_array()
                            .cloned()
                            .unwrap_or_default();
                        let items: Vec<Value> = notes
                            .as_array()
                            .unwrap()
                            .iter()
                            .filter(|n| wanted.is_empty() || wanted.contains(&n["id"]))
                            .cloned()
                            .collect();
                        json!({"content": [{"type": "text", "text": json!({"meetings": items}).to_string()}]})
                    }
                    _ => json!({}),
                };
                let message = json!({"jsonrpc": "2.0", "id": id, "result": result});
                if sse {
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
        for sse in [false, true] {
            let (endpoint, seen) = fictional_server(None, sse);
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
                ],
                "sse={sse}"
            );
            let fetched = connection.fetch(&["m2".into()]).unwrap();
            assert_eq!(fetched.len(), 1);
            assert_eq!(fetched[0].provider, Provider::Granola);
            assert_eq!(
                fetched[0].excerpt,
                "Visitors asked where to find watering cans."
            );
            let heads = seen.lock().unwrap().clone();
            assert!(heads.iter().all(|head| head
                .to_lowercase()
                .contains("authorization: bearer fictional-token")));
            // initialize, initialized, tools/list, list_meetings, get_meetings.
            assert_eq!(heads.len(), 5, "sse={sse}");
            // The session id the server issued is sent back after the first reply.
            assert!(heads
                .last()
                .unwrap()
                .to_lowercase()
                .contains("mcp-session-id: s-1"));
            assert!(!format!("{connection:?}").contains("fictional-token"));
        }
    }

    #[test]
    fn server_statuses_map_to_the_contract_errors() {
        for (status, expected) in [
            (401, SourceError::Expired),
            (403, SourceError::Revoked),
            (
                429,
                SourceError::RateLimited {
                    retry_after: Duration::from_secs(7),
                },
            ),
            (503, SourceError::Unavailable),
        ] {
            let (endpoint, _) = fictional_server(Some(status), false);
            assert_eq!(
                Connection::open_at(&endpoint, &tokens(), false).err(),
                Some(expected),
                "{status}"
            );
        }
        let (endpoint, _) = fictional_server(None, false);
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
