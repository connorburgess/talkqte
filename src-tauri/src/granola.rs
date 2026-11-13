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
use crate::context_refresh::RefreshSource;
use crate::notes_file::{NoteSummary, MAX_NOTES};
use quick_xml::{events::Event, Reader, XmlVersion};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    io::{Read, Write},
    net::{TcpListener, TcpStream},
    sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    },
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
        // Long enough for an assistant's answer, not only a file listing.
        .timeout_recv_response(Some(Duration::from_secs(90)))
        .timeout_recv_body(Some(Duration::from_secs(30)))
        .https_only(https_only)
        .http_status_as_error(false)
        // Every request, sign-in included, names this app to Granola.
        .user_agent(CLIENT_NAME)
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
    sign_in_at(RESOURCE, true, &granola_host, open_url, cancelled)
}

/// The sign-in against any resource; tests use a local fictional server
/// and say which hosts they trust in place of granola.ai.
fn sign_in_at(
    resource: &str,
    https_only: bool,
    granola_host: &dyn Fn(&str) -> bool,
    open_url: &dyn Fn(&str) -> Result<(), String>,
    cancelled: &dyn Fn() -> bool,
) -> Result<Tokens, String> {
    if cancelled() {
        return Err("Sign-in cancelled.".into());
    }
    let agent = agent(https_only);
    let origin = resource
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
        &well_known(
            &authorization_server,
            "oauth-authorization-server",
            https_only,
        )
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
    if cancelled() {
        return Err("Sign-in cancelled.".into());
    }
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
    if cancelled() {
        return Err("Sign-in cancelled.".into());
    }
    open_url(&authorize_url(
        &authorization_endpoint,
        &client_id,
        &redirect_uri,
        &challenge,
        &state,
    ))?;
    let code = wait_for_callback(&listener, &state, cancelled)?;
    if cancelled() {
        return Err("Sign-in cancelled.".into());
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
            ("resource", resource),
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
fn well_known(issuer: &str, suffix: &str, https_only: bool) -> Option<String> {
    // Plain http is for a test's loopback server only.
    let (scheme, rest) = issuer.split_once("://")?;
    if scheme != "https" && (https_only || scheme != "http") {
        return None;
    }
    let (host, path) = rest.split_once('/').unwrap_or((rest, ""));
    let path = path.trim_matches('/');
    Some(if path.is_empty() {
        format!("{scheme}://{host}/.well-known/{suffix}")
    } else {
        format!("{scheme}://{host}/.well-known/{suffix}/{path}")
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
    /// The argument its schema names for a free-text question, if any.
    query_argument: Option<String>,
    /// Every argument its schema names, so optional ones are sent only
    /// where they exist.
    arguments: Vec<String>,
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
        trace("tools/list", &listed);
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
        let Some(tool) = self.tool("list_meetings") else {
            return Err(SourceError::Unavailable);
        };
        // Granola lists the last 7 days unless told otherwise; the chooser
        // promises 30. Attendees are left out: the chooser shows titles and
        // dates, and names of other people are not needed.
        let mut arguments = serde_json::Map::new();
        if tool.arguments.iter().any(|name| name == "time_range") {
            arguments.insert("time_range".into(), json!("last_30_days"));
        }
        if tool.arguments.iter().any(|name| name == "max_participants") {
            arguments.insert("max_participants".into(), json!(0));
        }
        let result = self.call(
            "tools/call",
            json!({ "name": "list_meetings", "arguments": arguments }),
        )?;
        trace("list_meetings result", &result);
        let output = tool_output(&result);
        trace("list_meetings output", &output);
        if let Value::String(text) = &output {
            trace_text("list_meetings text", text);
        }
        let (notes, remaining) = if let Value::String(text) = &output {
            tagged_listing(text)?
        } else {
            (notes_in(&output), 0)
        };
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
        let skipped = (total - summaries.len()).saturating_add(remaining);
        Ok((summaries, skipped))
    }

    /// Whether the server offers the assistant that answers questions about
    /// the person's meetings; absent on some plans.
    pub fn can_suggest(&self) -> bool {
        self.tool("query_granola_meetings").is_some()
    }

    /// Asks Granola's assistant one fixed question about the person's recent
    /// meetings and returns its answer as candidate focus lines. The answer
    /// is a suggestion for the person to tick; nothing becomes a focus line
    /// until they accept it.
    pub fn suggest_focus(&mut self) -> Result<Vec<String>, SourceError> {
        let tool = self
            .tool("query_granola_meetings")
            .cloned()
            .ok_or(SourceError::Unavailable)?;
        let argument = tool.query_argument.unwrap_or_else(|| "query".into());
        let result = self.call(
            "tools/call",
            json!({ "name": tool.name, "arguments": { argument: FOCUS_QUESTION } }),
        )?;
        trace("query_granola_meetings result", &result);
        Ok(suggestions_in(&suggestion_text(&tool_output(&result))))
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

/// Developer trace, on only when `TALKQTE_GRANOLA_TRACE` is set: the
/// shape of tool schemas and replies. Only fixed structural field names
/// survive; keys, scalar values, and schema descriptions may contain private
/// data. Size and depth are bounded. Printed to stderr; the calling terminal
/// may retain it, so never print raw provider metadata here.
fn trace(label: &str, value: &Value) {
    if std::env::var_os("TALKQTE_GRANOLA_TRACE").is_none() {
        return;
    }
    eprintln!("granola trace: {label}: {}", shape(value));
}

/// The layout of a text reply with content masked. Only known structural
/// tag and attribute names survive; arbitrary names can themselves contain
/// meeting content. Output is bounded to 4 KB/80 tags plus a truncation marker.
fn trace_text(label: &str, text: &str) {
    if std::env::var_os("TALKQTE_GRANOLA_TRACE").is_none() {
        return;
    }
    eprintln!("granola trace: {label}: {}", text_layout(text));
}

/// Content-free outline: long provider notices and note bodies cannot crowd
/// the fields out of the diagnostic. Names still pass through the allowlist;
/// attribute values and text are omitted altogether, even for malformed XML.
fn text_layout(text: &str) -> String {
    let mut reader = Reader::from_str(text);
    let mut out = String::new();
    let mut events = 0;
    loop {
        let event = reader.read_event();
        let empty = matches!(event, Ok(Event::Empty(_)));
        let line = match event {
            Ok(Event::Start(tag) | Event::Empty(tag)) => {
                let mut line = format!("<{}", tag.name().as_ref());
                for attribute in tag.attributes().take(20) {
                    let Ok(attribute) = attribute else { break };
                    line.push_str(&format!(" {}=\"x\"", attribute.key.as_ref()));
                }
                line.push_str(if empty { "/>" } else { ">" });
                skeleton(&line)
            }
            Ok(Event::End(tag)) => skeleton(&format!("</{}>", tag.name().as_ref())),
            Ok(Event::Text(body)) if !body.as_ref().trim().is_empty() => {
                format!("[text:{}]", body.as_ref().chars().count())
            }
            Ok(Event::CData(body)) => format!("[cdata:{}]", body.as_ref().chars().count()),
            Ok(Event::Eof) => break,
            Err(_) => {
                out.push_str("[unrecognized markup]\n");
                break;
            }
            _ => continue,
        };
        if out.len() + line.len() > 4_000 || events >= 80 {
            out.push_str("[outline truncated]\n");
            break;
        }
        out.push_str(&line);
        out.push('\n');
        events += 1;
    }
    out
}

fn skeleton(text: &str) -> String {
    fn masked(c: char) -> char {
        if c.is_numeric() {
            '9'
        } else if c.is_ascii_punctuation() || matches!(c, ' ' | '\n' | '\r' | '\t') {
            c
        } else {
            'x'
        }
    }

    fn structural(name: &str) -> bool {
        matches!(
            name,
            "meeting"
                | "meetings"
                | "note"
                | "notes"
                | "title"
                | "date"
                | "id"
                | "meeting_id"
                | "created_at"
                | "updated_at"
                | "start_time"
                | "end_time"
                | "summary"
                | "content"
                | "text"
                | "url"
                | "participants"
                | "attendees"
                | "access_notice"
                | "has_more"
                | "total"
                | "count"
                | "meetings_data"
                | "meeting_at"
                | "pagination"
                | "total_count"
                | "remaining_count"
                | "next_cursor"
                | "private_notes"
                | "status"
                | "ai_summary"
                | "notes_markdown"
                | "enhanced_notes"
        )
    }

    let mut out = String::new();
    let mut chars = text.chars().take(2_000).peekable();
    let mut in_tag = false;
    let mut tag_name = false;
    let mut awaiting_value = false;
    // A space denotes an unquoted value; the other delimiters are quotes.
    let mut value_delimiter = None;
    while let Some(c) = chars.next() {
        if let Some(delimiter) = value_delimiter {
            if delimiter == ' ' && (c.is_whitespace() || c == '>') {
                value_delimiter = None;
            } else {
                if c == delimiter {
                    value_delimiter = None;
                }
                out.push(masked(c));
                continue;
            }
        }
        if awaiting_value && !c.is_whitespace() {
            awaiting_value = false;
            if c != '>' {
                value_delimiter = Some(if matches!(c, '\'' | '"') { c } else { ' ' });
                out.push(masked(c));
                continue;
            }
        }
        match c {
            '<' => {
                in_tag = true;
                tag_name = true;
                awaiting_value = false;
                out.push(c);
            }
            '>' => {
                in_tag = false;
                awaiting_value = false;
                out.push(c);
            }
            '=' if in_tag => {
                awaiting_value = true;
                out.push(c);
            }
            _ if in_tag && (c.is_alphanumeric() || c == '_') => {
                let mut name = String::from(c);
                while let Some(&next) = chars.peek() {
                    if !(next.is_alphanumeric() || matches!(next, '_' | '-' | ':')) {
                        break;
                    }
                    name.push(chars.next().unwrap());
                }
                let attribute_name = chars.clone().find(|c| !c.is_whitespace()) == Some('=');
                if (tag_name || attribute_name) && structural(&name) {
                    out.push_str(&name);
                } else {
                    out.extend(name.chars().map(masked));
                }
                tag_name = false;
            }
            _ => out.push(masked(c)),
        }
    }
    out
}

/// Bounded structure only: arbitrary keys and all scalar content are private.
fn shape(value: &Value) -> Value {
    fn visit(value: &Value, depth: usize, remaining: &mut usize) -> Value {
        if depth == 0 || *remaining == 0 {
            return json!("<truncated>");
        }
        *remaining -= 1;
        match value {
            Value::String(text) => json!(format!("<str:{}>", text.chars().count())),
            Value::Number(_) => json!("<number>"),
            Value::Bool(_) => json!("<boolean>"),
            Value::Null => Value::Null,
            Value::Array(items) => {
                let mut shapes: Vec<Value> = items
                    .iter()
                    .take(2)
                    .map(|item| visit(item, depth - 1, remaining))
                    .collect();
                if items.len() > 2 {
                    shapes.push(json!(format!("<+{} more>", items.len() - 2)));
                }
                Value::Array(shapes)
            }
            Value::Object(map) => {
                let mut shaped = serde_json::Map::new();
                for (index, (key, value)) in map.iter().take(20).enumerate() {
                    if *remaining == 0 {
                        shaped.insert("<truncated>".into(), Value::Null);
                        break;
                    }
                    let key = if matches!(
                        key.as_str(),
                        "content"
                            | "structuredContent"
                            | "text"
                            | "type"
                            | "isError"
                            | "tools"
                            | "name"
                            | "inputSchema"
                            | "properties"
                            | "items"
                            | "required"
                            | "description"
                            | "additionalProperties"
                            | "enum"
                            | "meetings"
                            | "notes"
                            | "data"
                            | "results"
                            | "id"
                            | "title"
                            | "date"
                            | "meeting_at"
                            | "created_at"
                            | "updated_at"
                            | "updatedAt"
                            | "summary"
                            | "private_notes"
                            | "notes_markdown"
                            | "notes_plain"
                            | "pagination"
                            | "has_more"
                            | "total_count"
                            | "remaining_count"
                            | "next_cursor"
                            | "status"
                    ) {
                        key.clone()
                    } else {
                        format!("<field:{index}>")
                    };
                    shaped.insert(key, visit(value, depth - 1, remaining));
                }
                if map.len() > 20 {
                    shaped.insert("<more fields>".into(), json!(map.len() - 20));
                }
                Value::Object(shaped)
            }
        }
    }
    visit(value, 8, &mut 80)
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
    let query_argument = properties.and_then(|properties| {
        ["query", "question", "prompt", "message", "text", "q"]
            .iter()
            .find(|candidate| properties.contains_key(**candidate))
            .map(|candidate| candidate.to_string())
            .or_else(|| {
                properties
                    .iter()
                    .find(|(_, schema)| schema["type"] == "string")
                    .map(|(key, _)| key.clone())
            })
    });
    let arguments = properties
        .map(|properties| properties.keys().cloned().collect())
        .unwrap_or_default();
    Some(Tool {
        name,
        ids_argument,
        query_argument,
        arguments,
    })
}

/// The one question put to Granola's assistant for focus suggestions. It
/// asks for open matters only, in the person's own meetings, without names,
/// so a suggestion can become a focus line as it is.
pub const FOCUS_QUESTION: &str = "From my meetings of the last 30 days, list the decisions still open, the tasks nobody has taken on, and the questions left unanswered. One short line each, at most five lines, no numbering, no people's names, no explanations.";
/// Suggestions a reply may contribute at most.
pub const MAX_SUGGESTIONS: usize = 8;
/// A suggestion longer than a focus line is cut.
const MAX_SUGGESTION_CHARS: usize = 80;

/// Openers of the assistant's chatter around a list, not items in it.
const CHATTER: &[&str] = &[
    "here is",
    "here's",
    "here are",
    "let me know",
    "would you like",
    "if you want",
    "if you'd like",
    "i found",
    "i couldn't",
    "i could not",
    "there are no",
    "no open",
    "sure",
];

/// Text without markup an assistant wraps around its answer: tags such as
/// `<access_notice>…</access_notice>` go, and so do markdown reference
/// links such as `[[11]](https://…)` or `[source](https://…)`, which cite a
/// note rather than say anything.
fn without_markup(line: &str) -> String {
    let mut out = String::with_capacity(line.len());
    let mut rest = line;
    while let Some(open) = rest.find('<') {
        out.push_str(&rest[..open]);
        match rest[open..].find('>') {
            Some(close) => rest = &rest[open + close + 1..],
            None => {
                // A lone "<" is text, not a tag.
                out.push_str(&rest[open..]);
                rest = "";
            }
        }
    }
    out.push_str(rest);
    // Links: a bracketed label followed by a parenthesised target.
    let mut text = out;
    while let Some(start) = text.find('[') {
        let after = &text[start..];
        let Some(label_end) = after.find("](") else {
            break;
        };
        let Some(target_len) = after[label_end + 2..].find(')') else {
            break;
        };
        let end = start + label_end + 2 + target_len + 1;
        text.replace_range(start..end, "");
    }
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Characters that show as nothing or reorder text, which a note could
/// carry to make a line read differently from what it is.
fn is_invisible(character: char) -> bool {
    matches!(
        character,
        '\u{200B}'..='\u{200F}' | '\u{202A}'..='\u{202E}' | '\u{2060}'..='\u{2064}' | '\u{FEFF}'
    )
}

/// The lines of a free-text reply, without bullets, numbering, quotes, or
/// emphasis marks, without the assistant's chatter around them, without
/// invisible characters, deduplicated, cut to a focus line's length, at
/// most `MAX_SUGGESTIONS`.
pub fn suggestions_in(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    for raw in text.lines() {
        let cleaned: String = raw.chars().filter(|c| !is_invisible(*c)).collect();
        // A line that opens with a tag is a notice around the answer, not an item.
        if cleaned.trim_start().starts_with('<') && cleaned.contains('>') {
            continue;
        }
        let cleaned = without_markup(&cleaned);
        let mut line = cleaned.trim();
        // A markdown heading introduces items; it is not one.
        if line.starts_with('#') {
            continue;
        }
        // Markdown bullets and headings: a mark followed by a space.
        loop {
            let before = line;
            for mark in ["- ", "* ", "• ", "· ", "+ ", "▪ ", "– ", "— "] {
                if let Some(rest) = line.strip_prefix(mark) {
                    line = rest.trim_start();
                }
            }
            if line == before {
                break;
            }
        }
        // Numbering such as "1. ", "2) ", "(3) ", only when a space follows,
        // so "3:30" and "1.5" keep their digits.
        let unparenthesised = line.trim_start_matches('(');
        let digits = unparenthesised
            .chars()
            .take_while(char::is_ascii_digit)
            .count();
        if digits > 0 {
            if let Some(rest) = unparenthesised[digits..]
                .strip_prefix(['.', ')', ':'])
                .and_then(|rest| rest.strip_prefix(' '))
            {
                line = rest.trim_start();
            }
        }
        let line = line
            .trim_matches(['"', '“', '”', '\'', '*', '_'])
            .trim()
            .trim_end_matches('.')
            .trim();
        let lower = line.to_lowercase();
        if line.is_empty()
            || line.ends_with(':')
            || CHATTER.iter().any(|opener| lower.starts_with(opener))
        {
            continue;
        }
        let cut: String = line.chars().take(MAX_SUGGESTION_CHARS).collect();
        if !lines.iter().any(|seen| seen.eq_ignore_ascii_case(&cut)) {
            lines.push(cut);
        }
        if lines.len() == MAX_SUGGESTIONS {
            break;
        }
    }
    lines
}

/// Suggestion lines from a tool output that is not plain text: an array of
/// strings, or an object with a text-like field. Anything else yields
/// nothing rather than a dump of the structure.
fn suggestion_text(output: &Value) -> String {
    match output {
        Value::String(text) => text.clone(),
        Value::Array(items) => items
            .iter()
            .filter_map(Value::as_str)
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(map) => ["answer", "response", "text", "content", "result", "summary"]
            .iter()
            .find_map(|key| map.get(*key))
            .map(suggestion_text)
            .unwrap_or_default(),
        _ => String::new(),
    }
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
    revision: u64,
}

/// The observed listing is a sequence of XML fragments with prose between
/// them. Only direct meeting children of meetings_data supply chooser rows;
/// participant, folder, and attachment content is deliberately skipped.
fn tagged_listing(text: &str) -> Result<(Vec<Note>, usize), SourceError> {
    tagged_meetings(text, false)
}

fn tagged_meetings(text: &str, details: bool) -> Result<(Vec<Note>, usize), SourceError> {
    let mut reader = Reader::from_str(text);
    let mut notes = Vec::new();
    let mut seen_ids = std::collections::HashSet::new();
    let mut in_data = false;
    let mut saw_data = false;
    let mut remaining = 0;
    loop {
        let event = reader.read_event().map_err(|_| SourceError::Unavailable)?;
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                let empty = matches!(event, Event::Empty(_));
                match tag.name().as_ref() {
                    "meetings_data" if !in_data => {
                        saw_data = true;
                        in_data = !empty;
                    }
                    "pagination" if !in_data => {
                        for attribute in tag.attributes() {
                            let attribute = attribute.map_err(|_| SourceError::Unavailable)?;
                            if attribute.key.as_ref() == "remaining_count" {
                                remaining = attribute
                                    .normalized_value(XmlVersion::Implicit1_0)
                                    .map_err(|_| SourceError::Unavailable)?
                                    .parse::<usize>()
                                    .map_err(|_| SourceError::Unavailable)?;
                            }
                        }
                        if !empty {
                            reader
                                .read_to_end(tag.name())
                                .map_err(|_| SourceError::Unavailable)?;
                        }
                    }
                    "meeting" if in_data => {
                        let mut fields = serde_json::Map::new();
                        for attribute in tag.attributes() {
                            let attribute = attribute.map_err(|_| SourceError::Unavailable)?;
                            let key = attribute.key.as_ref();
                            if matches!(
                                key,
                                "id" | "title"
                                    | "meeting_at"
                                    | "date"
                                    | "created_at"
                                    | "updated_at"
                            ) {
                                let value = attribute
                                    .normalized_value(XmlVersion::Implicit1_0)
                                    .map_err(|_| SourceError::Unavailable)?;
                                fields.insert(key.to_string(), Value::String(value.into_owned()));
                            }
                        }
                        if details && !empty {
                            fields.insert(
                                "notes".into(),
                                Value::String(tagged_note_text(&mut reader)?),
                            );
                        } else if !empty {
                            reader
                                .read_to_end(tag.name())
                                .map_err(|_| SourceError::Unavailable)?;
                        }
                        if let Some(note) = note_from(&Value::Object(fields)) {
                            if seen_ids.insert(note.id.clone()) {
                                notes.push(note);
                            }
                        }
                    }
                    _ if !empty => {
                        reader
                            .read_to_end(tag.name())
                            .map_err(|_| SourceError::Unavailable)?;
                    }
                    _ => {}
                }
            }
            Event::End(tag) if tag.name().as_ref() == "meetings_data" => in_data = false,
            // No DTD or custom entities are needed for provider metadata.
            Event::DocType(_) => return Err(SourceError::Unavailable),
            Event::Eof => break,
            _ => {}
        }
    }
    if !saw_data || in_data {
        return Err(SourceError::Unavailable);
    }
    Ok((notes, remaining))
}

/// Only the two observed direct content fields belong to a selected note.
/// Provider notices, attendees, attachments and nested meeting-shaped data
/// are not note content. Keep private notes and the generated summary labeled.
fn tagged_note_text(reader: &mut Reader<&[u8]>) -> Result<String, SourceError> {
    let mut private_notes = None;
    let mut summary = None;
    loop {
        let event = reader.read_event().map_err(|_| SourceError::Unavailable)?;
        match event {
            Event::Start(ref tag) | Event::Empty(ref tag) => {
                let empty = matches!(event, Event::Empty(_));
                let name = tag.name();
                if matches!(name.as_ref(), "private_notes" | "summary") {
                    let slot = if name.as_ref() == "private_notes" {
                        &mut private_notes
                    } else {
                        &mut summary
                    };
                    if slot.is_some() {
                        return Err(SourceError::Unavailable);
                    }
                    let mut unavailable = false;
                    for attribute in tag.attributes() {
                        let attribute = attribute.map_err(|_| SourceError::Unavailable)?;
                        if name.as_ref() == "private_notes" && attribute.key.as_ref() == "status" {
                            let status = attribute
                                .normalized_value(XmlVersion::Implicit1_0)
                                .map_err(|_| SourceError::Unavailable)?;
                            unavailable = matches!(status.as_ref(), "empty" | "not_included");
                        }
                    }
                    let content = if empty {
                        String::new()
                    } else if unavailable {
                        reader
                            .read_to_end(name)
                            .map_err(|_| SourceError::Unavailable)?;
                        String::new()
                    } else {
                        tagged_field_text(reader, name)?
                    };
                    *slot = Some(content);
                } else if !empty {
                    reader
                        .read_to_end(name)
                        .map_err(|_| SourceError::Unavailable)?;
                }
            }
            Event::End(tag) if tag.name().as_ref() == "meeting" => break,
            Event::DocType(_) | Event::Eof => return Err(SourceError::Unavailable),
            _ => {}
        }
    }
    if private_notes.is_none() && summary.is_none() {
        return Err(SourceError::Unavailable);
    }
    Ok([("Private notes", private_notes), ("Summary", summary)]
        .into_iter()
        .filter_map(|(label, text)| {
            text.filter(|s| !s.trim().is_empty())
                .map(|s| format!("{label}:\n{}", s.trim()))
        })
        .collect::<Vec<_>>()
        .join("\n\n"))
}

/// Markdown is carried as text, not rendered as HTML. Decode XML references
/// once and preserve line breaks/CDATA. Unknown nested formats fail explicitly
/// instead of importing their metadata or silently dropping part of a note.
fn tagged_field_text(
    reader: &mut Reader<&[u8]>,
    end: quick_xml::name::QName<'_>,
) -> Result<String, SourceError> {
    let mut text = String::new();
    loop {
        match reader.read_event().map_err(|_| SourceError::Unavailable)? {
            Event::Text(value) => text.push_str(&value.xml_content(XmlVersion::Implicit1_0)),
            Event::CData(value) => text.push_str(&value.xml_content(XmlVersion::Implicit1_0)),
            Event::GeneralRef(value) => {
                if let Some(character) = value
                    .resolve_char_ref()
                    .map_err(|_| SourceError::Unavailable)?
                {
                    text.push(character);
                } else {
                    text.push_str(
                        quick_xml::escape::resolve_predefined_entity(value.as_ref())
                            .ok_or(SourceError::Unavailable)?,
                    );
                }
            }
            Event::End(tag) if tag.name() == end => return Ok(text),
            Event::Comment(_) => {}
            _ => return Err(SourceError::Unavailable),
        }
    }
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
        // Granola's display date is prose; meeting_at is the ISO source date.
        "meeting_at",
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
    // Use the provider's update time, never fetch order or our local clock.
    // Unknown versions may be imported once but cannot overwrite a known
    // newer copy. Revision 1 also matches the original unversioned adapter.
    let revision = pick(&["updated_at", "updatedAt"])
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(&value).ok())
        .and_then(|time| u64::try_from(time.timestamp_millis()).ok())
        .filter(|version| *version > 1)
        .unwrap_or(1);
    Some(Note {
        id: id.trim().to_string(),
        title: title.chars().take(MAX_TITLE_CHARS).collect(),
        date,
        text,
        revision,
    })
}

/// The provider update time behind a Granola revision, in milliseconds since
/// 1970, or `None` for a copy imported without a usable `updated_at`.
pub fn updated_at_ms(revision: u64) -> Option<u64> {
    (revision > 1).then_some(revision)
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
/// The tool names are read once at connection, so status and capability
/// checks never wait on a call in flight.
#[derive(Clone, Debug)]
pub struct Shared {
    connection: Arc<Mutex<Option<Connection>>>,
    tools: Arc<Vec<String>>,
    disconnected: Arc<AtomicBool>,
}

impl Shared {
    pub fn new(connection: Connection) -> Self {
        Self {
            tools: Arc::new(connection.tool_names()),
            connection: Arc::new(Mutex::new(Some(connection))),
            disconnected: Arc::new(AtomicBool::new(false)),
        }
    }

    /// Retire every clone without waiting for an outstanding HTTP request.
    /// That request drops its response and credentials when it returns.
    pub fn disconnect(&self) {
        self.disconnected.store(true, Ordering::Release);
        if let Ok(mut connection) = self.connection.try_lock() {
            *connection = None;
        }
    }

    pub fn is_current(&self, current: Option<&Self>) -> bool {
        !self.disconnected.load(Ordering::Acquire)
            && current.is_some_and(|current| Arc::ptr_eq(&self.connection, &current.connection))
    }

    fn with_connection<T>(
        &self,
        call: impl FnOnce(&mut Connection) -> Result<T, SourceError>,
    ) -> Result<T, SourceError> {
        if self.disconnected.load(Ordering::Acquire) {
            return Err(SourceError::Revoked);
        }
        let mut connection = self
            .connection
            .lock()
            .map_err(|_| SourceError::Unavailable)?;
        // A queued call must recheck after acquiring the request lock.
        if self.disconnected.load(Ordering::Acquire) {
            *connection = None;
            return Err(SourceError::Revoked);
        }
        let result = call(connection.as_mut().ok_or(SourceError::Revoked)?);
        if self.disconnected.load(Ordering::Acquire) {
            *connection = None;
            return Err(SourceError::Revoked);
        }
        result
    }

    pub fn tool_names(&self) -> Vec<String> {
        if self.disconnected.load(Ordering::Acquire) {
            vec![]
        } else {
            self.tools.as_ref().clone()
        }
    }

    pub fn list_recent(&self) -> Result<(Vec<NoteSummary>, usize), SourceError> {
        self.with_connection(Connection::list_recent)
    }

    pub fn can_suggest(&self) -> bool {
        !self.disconnected.load(Ordering::Acquire)
            && self
                .tools
                .iter()
                .any(|tool| tool == "query_granola_meetings")
    }

    pub fn suggest_focus(&self) -> Result<Vec<String>, SourceError> {
        self.with_connection(Connection::suggest_focus)
    }
}

impl NoteSource for Shared {
    fn provider(&self) -> Provider {
        Provider::Granola
    }

    fn capabilities(&self) -> Capabilities {
        Capabilities {
            import_notes: !self.disconnected.load(Ordering::Acquire)
                && self.tools.iter().any(|tool| tool == "get_meetings"),
            ..Capabilities::default()
        }
    }

    fn fetch(&mut self, selection: &[String]) -> Result<Vec<ContextItem>, SourceError> {
        self.with_connection(|connection| connection.fetch(selection))
    }
}

/// The explicit update check (`context_refresh.rs`) needs the provider's own
/// identifier for the workspace a request is scoped to. Granola's MCP guide
/// describes active-workspace scope, but the tools this client has observed
/// name no workspace, so the check fails closed: the notebook does not offer
/// it for a real connection and no note identifier is sent. Change this only
/// after an account check establishes a provider-supported identity.
impl RefreshSource for Shared {
    fn binding_supported(&self) -> bool {
        false
    }

    fn workspace(&mut self) -> Result<Option<String>, SourceError> {
        Ok(None)
    }

    fn fetch_available(&mut self, selection: &[String]) -> Result<Vec<ContextItem>, SourceError> {
        self.with_connection(|connection| connection.fetch_available(selection))
    }
}

impl Connection {
    /// The selected notes the server returned, without requiring all of
    /// them. Notes it volunteers beyond the selection are dropped.
    fn fetch_available(&mut self, selection: &[String]) -> Result<Vec<ContextItem>, SourceError> {
        let tool = self
            .tool("get_meetings")
            .cloned()
            .ok_or(SourceError::Unavailable)?;
        let argument = tool.ids_argument.unwrap_or_else(|| "meeting_ids".into());
        let mut arguments = serde_json::Map::new();
        arguments.insert(argument, json!(selection));
        // Note excerpts need neither attendee metadata nor attachments.
        if tool.arguments.iter().any(|name| name == "max_participants") {
            arguments.insert("max_participants".into(), json!(0));
        }
        if tool.arguments.iter().any(|name| name == "attachments") {
            arguments.insert("attachments".into(), json!("none"));
        }
        let result = self.call(
            "tools/call",
            json!({ "name": tool.name, "arguments": arguments }),
        )?;
        trace("get_meetings result", &result);
        let output = tool_output(&result);
        let notes = if let Value::String(text) = &output {
            trace_text("get_meetings text", text);
            tagged_meetings(text, true)
                .map_err(|_| SourceError::UnsupportedFormat)?
                .0
        } else {
            notes_in(&output)
        };
        Ok(notes
            .into_iter()
            .filter(|note| selection.iter().any(|wanted| wanted == &note.id))
            .map(|note| ContextItem {
                provider: Provider::Granola,
                source_id: note.id,
                title: note.title,
                source_date: note.date,
                excerpt: note.text.trim().chars().take(MAX_EXCERPT_CHARS).collect(),
                revision: note.revision,
            })
            .collect())
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
        let items = self.fetch_available(selection)?;
        // Missing/inaccessible or size-omitted selections must not look like
        // a successful partial import. Keep the chooser available for retry
        // or a smaller selection; do not fetch more notes automatically.
        if selection
            .iter()
            .any(|id| !items.iter().any(|item| &item.source_id == id))
        {
            return Err(SourceError::Unavailable);
        }
        Ok(items)
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn detail_trace_reaches_fields_after_long_notices_without_content() {
        let text = format!("{}<meetings_data><meeting id='private-id' title='Private title'><private_notes status='empty'/><summary>{}</summary><PrivateName>private body</PrivateName></meeting></meetings_data>", "Long notice. ".repeat(500), "Long note body. ".repeat(500));
        let layout = text_layout(&text);
        assert!(layout.contains("<private_notes status=\"x\"/>"));
        assert!(layout.contains("<summary>"));
        assert!(layout.contains("</meeting>"));
        for secret in [
            "private-id",
            "Private title",
            "Long notice",
            "Long note",
            "PrivateName",
            "private body",
        ] {
            assert!(!layout.contains(secret));
        }
        assert!(layout.len() < 300);
    }

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
            well_known(
                "https://mcp-auth.granola.ai",
                "oauth-authorization-server",
                true
            )
            .unwrap(),
            "https://mcp-auth.granola.ai/.well-known/oauth-authorization-server"
        );
        assert_eq!(
            well_known(
                "https://mcp-auth.granola.ai/tenant/a/",
                "oauth-authorization-server",
                true
            )
            .unwrap(),
            "https://mcp-auth.granola.ai/.well-known/oauth-authorization-server/tenant/a"
        );
        assert!(well_known("http://mcp-auth.granola.ai", "x", true).is_none());
        assert!(well_known("ftp://127.0.0.1", "x", false).is_none());
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

    /// The `User-Agent` values in a request head.
    fn user_agents(head: &str) -> Vec<&str> {
        head.lines()
            .filter_map(|line| line.split_once(':'))
            .filter(|(name, _)| name.eq_ignore_ascii_case("user-agent"))
            .map(|(_, value)| value.trim())
            .collect()
    }

    /// A fictional sign-in service on a loopback port: resource and server
    /// metadata, client registration and the token exchange. Returns its
    /// origin and the requests it saw.
    pub(crate) fn fictional_sign_in_service() -> (String, Seen) {
        let listener = TcpListener::bind("127.0.0.1:0").unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let seen = Arc::new(Mutex::new(Vec::<(String, String)>::new()));
        let (log, base) = (seen.clone(), origin.clone());
        std::thread::spawn(move || {
            for stream in listener.incoming() {
                let Ok(mut stream) = stream else { break };
                let mut buffer = vec![0u8; 16384];
                let mut read = 0;
                let (head, body) = loop {
                    let n = stream.read(&mut buffer[read..]).unwrap_or(0);
                    read += n;
                    let text = String::from_utf8_lossy(&buffer[..read]).into_owned();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let length: usize = head
                            .lines()
                            .find_map(|line| {
                                line.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|value| value.trim().parse().unwrap_or(0))
                            })
                            .unwrap_or(0);
                        if body.len() >= length || n == 0 {
                            break (head.to_string(), body.to_string());
                        }
                    } else if n == 0 {
                        break (text, String::new());
                    }
                };
                let path = head.split(' ').nth(1).unwrap_or("").to_string();
                let reply = match path.as_str() {
                    "/.well-known/oauth-protected-resource" => {
                        json!({"authorization_servers": [base]})
                    }
                    "/.well-known/oauth-authorization-server" => json!({
                        "issuer": base,
                        "authorization_endpoint": format!("{base}/authorize"),
                        "token_endpoint": format!("{base}/token"),
                        "registration_endpoint": format!("{base}/register"),
                    }),
                    "/register" => json!({"client_id": "fictional-client"}),
                    "/token" => json!({"access_token": "fictional-token"}),
                    _ => json!({}),
                }
                .to_string();
                log.lock().unwrap().push((head, body));
                let _ = stream.write_all(
                    format!(
                        "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{reply}",
                        reply.len()
                    )
                    .as_bytes(),
                );
            }
        });
        (origin, seen)
    }

    /// A fictional browser that returns to the loopback address at once.
    pub(crate) fn fictional_browser(url: &str) -> Result<(), String> {
        {
            let query = url.split_once('?').unwrap().1;
            let value = |name: &str| {
                query
                    .split('&')
                    .find_map(|pair| pair.strip_prefix(&format!("{name}=")))
                    .map(percent_decode)
                    .unwrap()
            };
            let (redirect, state) = (value("redirect_uri"), value("state"));
            let address = redirect
                .strip_prefix("http://")
                .and_then(|rest| rest.strip_suffix("/callback"))
                .unwrap()
                .to_string();
            std::thread::spawn(move || {
                let mut stream = TcpStream::connect(address).unwrap();
                stream
                    .write_all(
                        format!(
                            "GET /callback?code=fictional-code&state={state} HTTP/1.1\r\nHost: x\r\n\r\n"
                        )
                        .as_bytes(),
                    )
                    .unwrap();
                let mut page = String::new();
                let _ = stream.read_to_string(&mut page);
            });
            Ok(())
        }
    }

    /// The real sign-in against a fictional service, trusting only its origin.
    pub(crate) fn sign_in_through(
        origin: &str,
        open_url: &dyn Fn(&str) -> Result<(), String>,
        cancelled: &dyn Fn() -> bool,
    ) -> Result<Tokens, String> {
        let trusted = |url: &str| url.starts_with(origin);
        sign_in_at(
            &format!("{origin}/mcp"),
            false,
            &trusted,
            open_url,
            cancelled,
        )
    }

    #[test]
    fn every_sign_in_request_names_talkqte_as_its_user_agent() {
        let (origin, seen) = fictional_sign_in_service();
        let tokens = sign_in_through(&origin, &fictional_browser, &|| false).unwrap();
        assert_eq!(tokens.access_token, "fictional-token");
        let seen = seen.lock().unwrap().clone();
        let lines: Vec<&str> = seen
            .iter()
            .map(|(head, _)| head.lines().next().unwrap())
            .collect();
        assert_eq!(
            lines,
            [
                "GET /.well-known/oauth-protected-resource HTTP/1.1",
                "GET /.well-known/oauth-authorization-server HTTP/1.1",
                "POST /register HTTP/1.1",
                "POST /token HTTP/1.1",
            ],
            "discovery, registration and the token exchange, nothing else"
        );
        for (head, _) in &seen {
            assert_eq!(user_agents(head), ["TalkQTE"], "{head}");
        }
        assert!(seen[3].1.contains("code=fictional-code"));
    }

    /// One whole session, from sign-in to disconnect. Run only in a child
    /// process by the test below, which redirects that process's home, app
    /// data and temporary folders and reads everything it prints.
    #[test]
    #[ignore = "run in a child process by the test below"]
    fn isolated_granola_session() {
        let (origin, _) = fictional_sign_in_service();
        let tokens = sign_in_through(&origin, &fictional_browser, &|| false).unwrap();
        let (endpoint, _) = fictional_server(Answer::TaggedListing);
        let shared = Shared::new(Connection::open_at(&endpoint, &tokens, false).unwrap());
        let (notes, _) = shared.list_recent().unwrap();
        assert_eq!(notes.len(), 2);
        let fetched = shared.clone().fetch(&["m2".into()]).unwrap();
        assert_eq!(
            fetched[0].excerpt,
            "Visitors asked where to find watering cans."
        );
        assert!(!shared.suggest_focus().unwrap().is_empty());
        // A failed request is part of a session too.
        let (failing, _) = fictional_server(Answer::RpcError("Unauthorized: token expired"));
        assert!(Connection::open_at(&failing, &tokens, false).is_err());
        shared.disconnect();
    }

    #[test]
    fn a_session_writes_no_file_and_prints_nothing_unless_the_trace_is_enabled() {
        for trace in [false, true] {
            let folder = std::env::temp_dir().join(format!(
                "talkqte-granola-isolated-{}-{trace}",
                std::process::id()
            ));
            let _ = std::fs::remove_dir_all(&folder);
            std::fs::create_dir_all(&folder).unwrap();
            let mut child = std::process::Command::new(std::env::current_exe().unwrap());
            child
                .args([
                    "granola::tests::isolated_granola_session",
                    "--exact",
                    "--ignored",
                    "--nocapture",
                    "--test-threads=1",
                ])
                .current_dir(&folder)
                .env_remove("TALKQTE_GRANOLA_TRACE");
            // Wherever the app or a library would keep data, a cache or a
            // temporary file on macOS, Windows or Linux.
            for name in [
                "HOME",
                "USERPROFILE",
                "APPDATA",
                "LOCALAPPDATA",
                "TMPDIR",
                "TEMP",
                "TMP",
                "XDG_DATA_HOME",
                "XDG_CONFIG_HOME",
                "XDG_CACHE_HOME",
                "XDG_STATE_HOME",
            ] {
                child.env(name, &folder);
            }
            if trace {
                child.env("TALKQTE_GRANOLA_TRACE", "1");
            }
            let output = child.output().unwrap();
            let printed = format!(
                "{}{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            );
            let left: Vec<_> = std::fs::read_dir(&folder)
                .unwrap()
                .flatten()
                .map(|entry| entry.file_name())
                .collect();
            let _ = std::fs::remove_dir_all(&folder);
            assert!(
                output.status.success() && printed.contains("1 passed"),
                "the session did not run: {printed}"
            );
            assert!(left.is_empty(), "the session left files: {left:?}");
            for private in [
                "fictional-token",
                "fictional-code",
                "fictional-client",
                "gardener@example.com",
                "robin@example.com",
                "Garden welcome guide",
                "Visitor questions",
                "watering cans",
                "launch plan",
                "compost bins",
            ] {
                assert!(!printed.contains(private), "printed {private}: {printed}");
            }
            assert_eq!(
                printed.contains("granola trace:"),
                trace,
                "the trace follows TALKQTE_GRANOLA_TRACE: {printed}"
            );
            if trace {
                for label in [
                    "tools/list",
                    "list_meetings result",
                    "get_meetings result",
                    "query_granola_meetings result",
                ] {
                    assert!(
                        printed.contains(&format!("granola trace: {label}:")),
                        "{label}"
                    );
                }
            }
        }
    }

    /// How the fictional server answers: normally (as JSON or an event
    /// stream), with an HTTP status, with a JSON-RPC error, or with a tool
    /// result that reports failure.
    #[derive(Clone, Copy)]
    pub(crate) enum Answer {
        Json,
        EventStream,
        TaggedListing,
        TaggedDetails(&'static str),
        Status(u16),
        RpcError(&'static str),
        ToolError,
    }

    /// A fictional MCP server on a loopback port with fixed notes; it logs
    /// each request's head and body.
    /// The requests a fictional server saw: each one's head and body.
    pub(crate) type Seen = Arc<Mutex<Vec<(String, String)>>>;

    pub(crate) fn fictional_server(answer: Answer) -> (String, Seen) {
        fictional_server_with_gate(answer, None)
    }

    type ResponseGate = (std::sync::mpsc::Sender<()>, std::sync::mpsc::Receiver<()>);

    fn fictional_server_with_gate(
        answer: Answer,
        mut gate: Option<ResponseGate>,
    ) -> (String, Seen) {
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
                if request["method"] == "tools/call" {
                    if let Some((started, release)) = gate.take() {
                        started.send(()).unwrap();
                        release.recv_timeout(Duration::from_secs(5)).unwrap();
                    }
                }
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
                        {"name": "list_meetings", "inputSchema": {"type": "object", "properties": {"time_range": {"type": "string"}, "max_participants": {"type": "integer"}}}},
                        {"name": "get_meetings", "inputSchema": {"type": "object", "properties": {"meeting_ids": {"type": "array", "items": {"type": "string"}}, "attachments": {"type": "string"}, "max_participants": {"type": "integer"}}}},
                        {"name": "query_granola_meetings", "inputSchema": {"type": "object", "properties": {"question": {"type": "string"}}}}
                    ]}),
                    Some("tools/call") if matches!(answer, Answer::ToolError) => {
                        json!({"isError": true, "content": [{"type": "text", "text": "Something went wrong."}]})
                    }
                    Some("tools/call")
                        if matches!(answer, Answer::TaggedListing)
                            && request["params"]["name"] == "list_meetings" =>
                    {
                        json!({"content": [{"type": "text", "text": TAGGED_LISTING}]})
                    }
                    Some("tools/call")
                        if matches!(answer, Answer::TaggedDetails(_))
                            && request["params"]["name"] == "get_meetings" =>
                    {
                        let Answer::TaggedDetails(text) = answer else {
                            unreachable!()
                        };
                        json!({"content": [{"type": "text", "text": text}]})
                    }
                    Some("tools/call") if request["params"]["name"] == "query_granola_meetings" => {
                        json!({"content": [{"type": "text", "text": "Here is what is still open:\n\n1. Agree the launch plan for the newsletter\n2. Decide who owns the compost bins\n- “Settle the volunteer schedule”\n- Agree the launch plan for the newsletter\n\nLet me know if you want more detail."}]})
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

    pub(crate) fn tokens() -> Tokens {
        Tokens {
            access_token: "fictional-token".into(),
        }
    }

    #[test]
    fn a_session_lists_recent_notes_and_fetches_only_the_selection() {
        for answer in [Answer::Json, Answer::EventStream, Answer::TaggedListing] {
            let (endpoint, seen) = fictional_server(answer);
            let mut connection = Connection::open_at(&endpoint, &tokens(), false).unwrap();
            assert_eq!(
                connection.tool_names(),
                ["list_meetings", "get_meetings", "query_granola_meetings"]
            );
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
            // Once, although both the agent and the request name it.
            for (head, _) in &seen {
                assert_eq!(user_agents(head), ["TalkQTE"], "{head}");
            }
            assert!(
                !seen[0].0.to_lowercase().contains("mcp-session-id"),
                "none before the server issues one"
            );
            assert!(seen[4].0.to_lowercase().contains("mcp-session-id: s-1"));
            let listed: Value = serde_json::from_str(&seen[3].1).unwrap();
            assert_eq!(
                listed["params"]["arguments"],
                json!({"time_range": "last_30_days", "max_participants": 0}),
                "the chooser promises 30 days and needs no attendees"
            );
            let asked: Value = serde_json::from_str(&seen[4].1).unwrap();
            assert_eq!(asked["params"]["arguments"]["meeting_ids"], json!(["m2"]));
            assert!(!format!("{connection:?}").contains("fictional-token"));
        }
    }

    // Same structure as the observed provider listing; all values are fictional.
    const TAGGED_LISTING: &str = r#"
<pagination has_more="false" total_count="2" remaining_count="0" />
<requested_range time_range="last_30_days">Recent notes</requested_range>
The default range is the last thirty days.
<meetings_data connected_user_email="gardener@example.com" count="2">
  <meeting id="m1" title="Garden welcome guide" date="Oct 28, 2026 10:00 am UTC" meeting_at="2026-10-28T10:00:00Z">
    <known_participants>Robin (robin@example.com)</known_participants>
    <folders />
  </meeting>
  <meeting id="m2" title="Visitor questions" date="Nov 2, 2026 9:00 am UTC" meeting_at="2026-11-02T09:00:00Z" />
</meetings_data>"#;

    #[test]
    fn tagged_listing_decodes_metadata_without_importing_other_content() {
        let (notes, remaining) = tagged_listing(TAGGED_LISTING).unwrap();
        assert_eq!(remaining, 0);
        assert_eq!(notes.len(), 2);
        assert_eq!(notes[0].date, "2026-10-28");
        assert!(notes.iter().all(|note| note.text.is_empty()));
        let (notes, remaining) = tagged_listing(r#"
<pagination remaining_count="7" />
<meeting id="outside" title="Not a row" />
<meetings_data>
  <meeting id='m&amp;1' title='Café &amp; &quot;Garden&quot; &gt; shed &#x1F331;' meeting_at='2026-11-02T09:00:00+07:00'>
    <known_participants><meeting id="nested" title="Not a row" /></known_participants>
  </meeting>
  <meeting id='m&amp;1' title='Duplicate' />
  <meeting title='Missing ID' />
</meetings_data>"#).unwrap();
        assert_eq!(remaining, 7);
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].id, "m&1");
        assert_eq!(notes[0].title, "Café & \"Garden\" > shed 🌱");
        assert_eq!(notes[0].date, "2026-11-02");
        assert!(notes[0].text.is_empty());
        assert_eq!(tagged_listing("<meetings_data />").unwrap(), (vec![], 0));
    }

    #[test]
    fn invalid_tagged_listings_are_errors_instead_of_empty_results() {
        for text in [
            "A different response format",
            "<meetings_data><meeting id='m1'>",
            "<meetings_data><meeting id='m1' id='m2' /></meetings_data>",
            "<meetings_data><meeting id='m1' title='&unknown;' /></meetings_data>",
            "<meetings_data><meeting id='m1' /></different>",
            "<pagination remaining_count='many'/><meetings_data/>",
            "<!DOCTYPE meetings_data><meetings_data />",
        ] {
            assert!(tagged_listing(text).is_err(), "invalid reply: {text}");
        }
    }

    #[test]
    fn unrecognized_details_fail_instead_of_reporting_a_successful_empty_import() {
        let (endpoint, _) = fictional_server(Answer::TaggedDetails(
            "<meeting id=\"m2\"><unknown>Fictional note</unknown></meeting>",
        ));
        let mut connection = Connection::open_at(&endpoint, &tokens(), false).unwrap();
        assert_eq!(
            connection.fetch(&["m2".into()]),
            Err(SourceError::UnsupportedFormat)
        );
    }

    const TAGGED_DETAILS: &str = include_str!("../tests/fixtures/granola-details.xml");

    #[test]
    fn selected_note_reimports_refresh_newer_content_but_never_roll_back() {
        const NEWER: &str = "<meetings_data><meeting id='m2' title='Visitor questions' meeting_at='2026-11-02T09:00:00Z' updated_at='2026-11-02T10:00:00.001Z'><summary>Watering cans moved beside the shed.</summary></meeting></meetings_data>";
        const SAME_IN_ANOTHER_ZONE: &str = "<meetings_data><meeting id='m2' title='Visitor questions' meeting_at='2026-11-02T09:00:00Z' updated_at='2026-11-02T17:00:00.001+07:00'><summary>Same revision must not replace the copy.</summary></meeting></meetings_data>";
        const UNKNOWN: &str = "<meetings_data><meeting id='m2' title='Visitor questions' meeting_at='2026-11-02T09:00:00Z' updated_at='not a timestamp'><summary>Unknown revision must not replace the copy.</summary></meeting></meetings_data>";
        let selection = vec!["m2".into()];
        let mut store = crate::context::ContextStore::default();
        for (text, expected_counts, expected_excerpt) in [
            (
                TAGGED_DETAILS,
                (1, 0, 0),
                "Summary:\nVisitors asked where to find watering cans.",
            ),
            (
                NEWER,
                (0, 1, 0),
                "Summary:\nWatering cans moved beside the shed.",
            ),
            (
                NEWER,
                (0, 0, 1),
                "Summary:\nWatering cans moved beside the shed.",
            ),
            (
                TAGGED_DETAILS,
                (0, 0, 1),
                "Summary:\nWatering cans moved beside the shed.",
            ),
            (
                SAME_IN_ANOTHER_ZONE,
                (0, 0, 1),
                "Summary:\nWatering cans moved beside the shed.",
            ),
            (
                UNKNOWN,
                (0, 0, 1),
                "Summary:\nWatering cans moved beside the shed.",
            ),
        ] {
            // Reconnecting does not reset the provider's revision ordering.
            let (endpoint, _) = fictional_server(Answer::TaggedDetails(text));
            let mut connection = Connection::open_at(&endpoint, &tokens(), false).unwrap();
            let fetched = connection.fetch(&selection).unwrap();
            let outcome = store.merge(Provider::Granola, &selection, fetched);
            assert_eq!(
                (outcome.added, outcome.updated, outcome.unchanged),
                expected_counts
            );
            assert_eq!(store.items().len(), 1);
            assert_eq!(store.items()[0].excerpt, expected_excerpt);
            assert_eq!(
                store.items()[0].source_date,
                "2026-11-02",
                "revision is not the meeting date"
            );
        }
    }

    #[test]
    fn absent_or_invalid_update_times_stay_unversioned_without_blocking_first_import() {
        for updated in [
            Value::Null,
            json!(""),
            json!("yesterday"),
            json!("2026-02-30T12:00:00Z"),
            json!("2026-11-02T10:00:00"),
            json!("1960-01-01T00:00:00Z"),
            json!(999),
        ] {
            let note = note_from(&json!({"id": "m1", "updated_at": updated, "created_at": "2026-11-02T00:00:00Z", "text": "A fictional note."})).unwrap();
            assert_eq!(
                note.revision, 1,
                "a meeting or fetch date must not invent a revision"
            );
        }
        let snake =
            note_from(&json!({"id":"m1", "updated_at":"2026-11-02T10:00:00.123Z"})).unwrap();
        let camel =
            note_from(&json!({"id":"m1", "updatedAt":"2026-11-02T17:00:00.123+07:00"})).unwrap();
        assert!(snake.revision > 1);
        assert_eq!(snake.revision, camel.revision);
        let (endpoint, _) = fictional_server(Answer::Json);
        let mut connection = Connection::open_at(&endpoint, &tokens(), false).unwrap();
        let ids = vec!["m2".into()];
        let mut store = crate::context::ContextStore::default();
        assert_eq!(
            store
                .merge(Provider::Granola, &ids, connection.fetch(&ids).unwrap())
                .added,
            1
        );
    }

    #[test]
    fn tagged_details_import_only_the_selection_through_the_real_store_path() {
        let (endpoint, seen) = fictional_server(Answer::TaggedDetails(TAGGED_DETAILS));
        let mut connection = Connection::open_at(&endpoint, &tokens(), false).unwrap();
        let (listed, _) = connection.list_recent().unwrap();
        let ids = vec![listed[1].source_id.clone()];
        let mut pending = crate::context_import::PendingImport::new(Box::new(connection));
        let mut attempt = pending.start().unwrap();
        let fetched = attempt.fetch(&ids).unwrap();
        assert!(pending.restore(attempt));
        let mut store = crate::context::ContextStore::default();
        let outcome = store.merge(Provider::Granola, &ids, fetched);
        assert_eq!(outcome.added, 1);
        assert_eq!(outcome.rejected, 0);
        let note = &store.items()[0];
        assert_eq!(note.source_id, "m2");
        assert_eq!(note.title, "Visitor questions");
        assert_eq!(note.source_date, "2026-11-02");
        assert_eq!(
            note.excerpt,
            "Summary:\nVisitors asked where to find watering cans."
        );
        assert_eq!(note.provider, Provider::Granola);
        let seen = seen.lock().unwrap();
        assert_eq!(
            seen.len(),
            5,
            "no transcript, attachment or follow-up calls"
        );
        let request: Value = serde_json::from_str(&seen[4].1).unwrap();
        assert_eq!(
            request["params"]["arguments"],
            json!({"meeting_ids": ["m2"], "max_participants": 0, "attachments": "none"})
        );
    }

    #[test]
    fn tagged_details_keep_content_labels_and_skip_metadata() {
        let (notes, _) = tagged_meetings(TAGGED_DETAILS, true).unwrap();
        assert_eq!(
            notes[0].text,
            "Private notes:\nBring a map of the tool shed.\n\nSummary:\nDraft a one-page guide."
        );
        assert_eq!(notes.len(), 2);
        // Missing private text must not hide an available summary. Text in an
        // unavailable private field is a status notice, never a personal note.
        let (notes, _) = tagged_meetings(
            r#"<meetings_data>
          <meeting id="m1" created_at="2026-11-02T00:00:00Z">
            <private_notes status="not_included">Not yours.</private_notes>
            <summary># Café &amp; garden &#x1F331;
- Keep &lt;two&gt; bins.
<![CDATA[- Plain <text> & symbols.]]></summary>
          </meeting>
          <meeting id="m1"><summary>Duplicate</summary></meeting>
        </meetings_data>"#,
            true,
        )
        .unwrap();
        assert_eq!(notes.len(), 1);
        assert_eq!(notes[0].date, "2026-11-02");
        assert_eq!(
            notes[0].text,
            "Summary:\n# Café & garden 🌱\n- Keep <two> bins.\n- Plain <text> & symbols."
        );
    }

    #[test]
    fn malformed_or_unrecognized_details_never_become_note_content() {
        for text in [
            "plain prose",
            "<meetings_data><meeting id='m1'><summary>cut off",
            "<meetings_data><meeting id='m1'><summary>wrong end</private_notes></meeting></meetings_data>",
            "<meetings_data><meeting id='m1' id='m2'><summary>duplicate id</summary></meeting></meetings_data>",
            "<meetings_data><meeting id='m1'><summary>&unknown;</summary></meeting></meetings_data>",
            "<meetings_data><meeting id='m1'><summary><unknown>nested format</unknown></summary></meeting></meetings_data>",
            "<meetings_data><meeting id='m1'><summary>one</summary><summary>two</summary></meeting></meetings_data>",
            "<meetings_data><meeting id='m1'><attachments><summary>not note text</summary></attachments></meeting></meetings_data>",
            "<!DOCTYPE meetings_data><meetings_data/>",
        ] {
            assert!(tagged_meetings(text, true).is_err(), "invalid reply: {text}");
        }
    }

    #[test]
    fn empty_note_content_is_counted_as_skipped_without_adding_context() {
        const EMPTY: &str = "<meetings_data><meeting id='m1' meeting_at='2026-11-02T00:00:00Z'><private_notes status='empty'/><summary/></meeting></meetings_data>";
        let (endpoint, _) = fictional_server(Answer::TaggedDetails(EMPTY));
        let mut connection = Connection::open_at(&endpoint, &tokens(), false).unwrap();
        let ids = vec!["m1".into()];
        let mut store = crate::context::ContextStore::default();
        assert_eq!(
            store
                .merge(Provider::Granola, &ids, connection.fetch(&ids).unwrap())
                .rejected,
            1
        );
        assert!(store.items().is_empty());
    }

    #[test]
    fn omitted_selected_notes_fail_without_silently_importing_a_partial_selection() {
        let (endpoint, seen) = fictional_server(Answer::TaggedDetails(TAGGED_DETAILS));
        let mut connection = Connection::open_at(&endpoint, &tokens(), false).unwrap();
        assert_eq!(
            connection.fetch(&["m2".into(), "omitted-note".into()]),
            Err(SourceError::Unavailable)
        );
        assert_eq!(
            seen.lock().unwrap().len(),
            4,
            "no automatic follow-up reads"
        );
    }

    #[test]
    fn an_update_check_fails_closed_without_asking_granola_for_any_note() {
        use crate::context::ContextStore;
        use crate::context_refresh::{CheckStatus, Refresh, CHECK_TIMEOUT};
        let (endpoint, seen) = fictional_server(Answer::Json);
        let mut shared = Shared::new(Connection::open_at(&endpoint, &tokens(), false).unwrap());
        assert!(!shared.binding_supported());
        let mut store = ContextStore::default();
        let selection = ["m2".to_string()];
        let fetched = shared.fetch(&selection).unwrap();
        store.merge(Provider::Granola, &selection, fetched);
        let before = seen.lock().unwrap().len();
        let mut refresh = Refresh::default();
        let ticket = refresh.begin(&store).unwrap();
        let result = crate::context_refresh::run(&ticket, Box::new(shared.clone()), CHECK_TIMEOUT);
        let report = refresh.apply(&ticket, result, &mut store, 0);
        assert_eq!(report.status, CheckStatus::WorkspaceUnverified);
        assert_eq!(
            seen.lock().unwrap().len(),
            before,
            "no request without a provider-supported workspace identity"
        );
        assert_eq!(store.items().len(), 1);

        // The request a verified binding would allow returns what the server
        // has for the selection instead of failing on an omitted note.
        let available = shared
            .fetch_available(&["m2".into(), "omitted-note".into()])
            .unwrap();
        assert_eq!(available.len(), 1);
        assert_eq!(available[0].source_id, "m2");
        let asked: Value = serde_json::from_str(&seen.lock().unwrap().last().unwrap().1).unwrap();
        assert_eq!(
            asked["params"]["arguments"]["meeting_ids"],
            json!(["m2", "omitted-note"])
        );
    }

    #[test]
    fn the_assistant_is_asked_one_fixed_question_and_its_lines_become_suggestions() {
        let (endpoint, seen) = fictional_server(Answer::Json);
        let mut connection = Connection::open_at(&endpoint, &tokens(), false).unwrap();
        assert!(connection.can_suggest());
        let suggestions = connection.suggest_focus().unwrap();
        assert_eq!(
            suggestions,
            [
                "Agree the launch plan for the newsletter",
                "Decide who owns the compost bins",
                "Settle the volunteer schedule",
            ],
            "bullets, numbering, quotes, and a repeat are stripped; headings ending in a colon and chatter are dropped"
        );
        let parsed = suggestions_in(
            "**Open decisions:**\n## Items\n10. Confirm the 3:30 slot for the visit\n(1) Review the 1.5 million budget line\n-5% cut on signage printing\n· Agree the newsletter launch\n* agree the Newsletter Launch\n\u{202E}Decide the fence colour\nWould you like more?",
        );
        assert_eq!(
            parsed,
            [
                "Confirm the 3:30 slot for the visit",
                "Review the 1.5 million budget line",
                "-5% cut on signage printing",
                "Agree the newsletter launch",
                "Decide the fence colour",
            ]
        );
        assert_eq!(
            suggestions_in(&suggestion_text(&json!([
                "Settle the schedule",
                3,
                "Agree the plan"
            ]))),
            ["Settle the schedule", "Agree the plan"]
        );
        assert!(suggestions_in(&suggestion_text(&json!({"meetings": [{"id": "m1"}]}))).is_empty());
        assert_eq!(
            suggestions_in(&suggestion_text(
                &json!({"answer": "- Settle the schedule"})
            )),
            ["Settle the schedule"]
        );
        let asked: Value = serde_json::from_str(&seen.lock().unwrap().last().unwrap().1).unwrap();
        assert_eq!(asked["params"]["name"], "query_granola_meetings");
        assert_eq!(
            asked["params"]["arguments"]["question"], FOCUS_QUESTION,
            "the argument name comes from the schema"
        );
        // Without the tool there is no suggestion, and the interface knows.
        drop(connection.tools.pop());
        assert!(!connection.can_suggest());
        assert_eq!(
            connection.suggest_focus().err(),
            Some(SourceError::Unavailable)
        );
        // Long replies are bounded.
        let many: String = (0..20)
            .map(|i| format!("{i}. Settle item number {i}\n"))
            .collect();
        assert_eq!(suggestions_in(&many).len(), MAX_SUGGESTIONS);
        assert_eq!(suggestions_in(&"x".repeat(200))[0].chars().count(), 80);
        assert!(suggestions_in("Open items:\n\n").is_empty());
    }

    #[test]
    fn tags_and_citation_links_around_suggestions_are_not_content() {
        let cited = suggestions_in(
            "<access_notice>Some notes were excluded because of their date.</access_notice>\n1. Decide the signage budget. [[11]](https://example.test/notes/11)\n2. Confirm the launch date [[2]](https://example.test/notes/2) with the committee.\n- Agree the welcome guide <em>soon</em> [source](https://example.test/x)",
        );
        assert_eq!(
            cited,
            [
                "Decide the signage budget",
                "Confirm the launch date with the committee",
                "Agree the welcome guide soon",
            ]
        );
        assert_eq!(without_markup("a < b and [x] alone"), "a < b and [x] alone");
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
    fn disconnect_discards_delayed_results_and_stops_queued_requests() {
        // Exercise each read path with a response held by the fictional server.
        for operation in ["list", "suggest", "fetch"] {
            let (started, received) = std::sync::mpsc::channel();
            let (release, resume) = std::sync::mpsc::channel();
            let (endpoint, seen) =
                fictional_server_with_gate(Answer::Json, Some((started, resume)));
            let shared = Shared::new(Connection::open_at(&endpoint, &tokens(), false).unwrap());
            let mut in_flight = shared.clone();
            let request = std::thread::spawn(move || match operation {
                "list" => in_flight.list_recent().map(|_| ()),
                "suggest" => in_flight.suggest_focus().map(|_| ()),
                _ => in_flight.fetch(&["m1".into()]).map(|_| ()),
            });
            received.recv_timeout(Duration::from_secs(5)).unwrap();
            let queued = shared.clone();
            let waiting = std::thread::spawn(move || queued.list_recent());

            // Retirement must not wait for the provider or permit an old clone
            // to become current when a replacement account connects.
            shared.disconnect();
            let (new_endpoint, _) = fictional_server(Answer::Json);
            let replacement =
                Shared::new(Connection::open_at(&new_endpoint, &tokens(), false).unwrap());
            assert!(!shared.is_current(Some(&replacement)));
            assert!(!shared.is_current(Some(&shared)));
            assert!(replacement.is_current(Some(&replacement.clone())));
            assert!(!replacement.is_current(None));
            release.send(()).unwrap();
            assert_eq!(request.join().unwrap(), Err(SourceError::Revoked));
            assert_eq!(waiting.join().unwrap().err(), Some(SourceError::Revoked));
            assert!(!shared.can_suggest());
            assert!(!shared.capabilities().import_notes);
            assert!(shared.tool_names().is_empty());
            assert!(
                shared.connection.lock().unwrap().is_none(),
                "retired credentials dropped"
            );
            let calls = seen
                .lock()
                .unwrap()
                .iter()
                .filter(|(_, body)| {
                    serde_json::from_str::<Value>(body).unwrap()["method"] == "tools/call"
                })
                .count();
            assert_eq!(calls, 1, "queued request never reached the retired account");
            assert!(replacement.list_recent().is_ok());
        }
    }

    #[test]
    fn disconnect_drops_idle_credentials_and_all_clones_lose_access() {
        let (endpoint, seen) = fictional_server(Answer::Json);
        let shared = Shared::new(Connection::open_at(&endpoint, &tokens(), false).unwrap());
        let mut retained = shared.clone();
        shared.disconnect();
        assert!(shared.connection.lock().unwrap().is_none());
        assert_eq!(
            retained.fetch(&["m1".into()]).err(),
            Some(SourceError::Revoked)
        );
        assert_eq!(retained.suggest_focus().err(), Some(SourceError::Revoked));
        assert_eq!(
            seen.lock().unwrap().len(),
            3,
            "only the initial handshake was sent"
        );
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
        connection.tools.retain(|tool| tool.name != "get_meetings");
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
    fn the_trace_shape_carries_structure_but_no_content() {
        let shaped = shape(
            &json!({"meetings": [{"id": "m1", "title": "Garden welcome guide", "notes": "Draft a map."}, {"id": "m2"}, {"id": "m3"}], "n": 3}),
        );
        assert_eq!(
            shaped,
            json!({"meetings": [{"id": "<str:2>", "title": "<str:20>", "notes": "<str:12>"}, {"id": "<str:2>"}, "<+1 more>"], "<field:1>": "<number>"})
        );
        assert_eq!(
            skeleton("<meeting id=\"m-1\" date=\"2026-11-10\">\n<title>Garden day</title> 3 notes</meeting>"),
            "<meeting id=\"x-9\" date=\"9999-99-99\">\n<title>xxxxxx xxx</title> 9 xxxxx</meeting>"
        );
        assert!(!shaped.to_string().contains("Garden"));
    }

    #[test]
    fn trace_masks_private_keys_scalars_and_tool_metadata_with_bounded_output() {
        let value = json!({
            "Garden private agenda": {"title": "Fictional orchard launch", "count": 873421},
            "tools": [{"name": "private-tool-name", "description": "fictional-token-secret",
                "inputSchema": {"properties": {"visitor@example.com": {
                    "default": "Private seed inventory", "enum": ["Hidden apple variety"],
                    "enabled": true, "amount": 938271
                }}}}],
            "summary": "Private tools and summaries must not be printed verbatim"
        });
        let output = shape(&value).to_string();
        for private in [
            "Garden",
            "orchard",
            "873421",
            "private-tool-name",
            "fictional-token-secret",
            "visitor@example.com",
            "Private seed",
            "Hidden apple",
            "938271",
            "true",
        ] {
            assert!(
                !output.contains(private),
                "private content survived: {private}"
            );
        }
        assert!(output.contains("inputSchema"));
        assert!(output.contains("<number>"));
        let mut deep = json!("private deepest value");
        for _ in 0..40 {
            deep = json!({"content": deep});
        }
        let mut wide = serde_json::Map::new();
        for i in 0..100 {
            wide.insert(format!("private field {i}"), deep.clone());
        }
        let output = shape(&Value::Object(wide)).to_string();
        assert!(output.len() < 10_000);
        assert!(output.contains("truncated"));
        assert!(!output.contains("private"));
    }

    #[test]
    fn text_trace_masks_attribute_values_and_arbitrary_markup() {
        assert_eq!(
            skeleton("<meeting title='Garden day' id=m-1 date = \"2026-11-10\">"),
            "<meeting title='xxxxxx xxx' id=x-9 date = \"9999-99-99\">"
        );
        // Known field names in values must also be masked, even when a value
        // contains apparent markup. Unknown tag/attribute names are private.
        assert_eq!(
            skeleton("<meeting title='notes <date>' id=title Garden=notes><Orchid>"),
            "<meeting title='xxxxx <xxxx>' id=xxxxx xxxxxx=xxxxx><xxxxxx>"
        );
        assert_eq!(
            skeleton("<meeting title='Garden <date>"),
            "<meeting title='xxxxxx <xxxx>"
        );
        assert_eq!(
            skeleton("<Garden planning tomorrow>"),
            "<xxxxxx xxxxxxxx xxxxxxxx>"
        );
        assert_eq!(skeleton("東京 ٢٣ 🌱\u{001b}[31m"), "xx 99 xx[99x");
        assert_eq!(skeleton(&"é".repeat(2_001)), "x".repeat(2_000));
    }

    #[test]
    fn an_event_stream_yields_the_reply_with_the_matching_id() {
        let text = "event: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":3,\"result\":{}}\n\nevent: message\ndata: {\"jsonrpc\":\"2.0\",\"id\":4,\"result\":{\"ok\":true}}\n\n";
        assert_eq!(sse_message(text, 4).unwrap()["result"]["ok"], true);
        assert!(sse_message(text, 9).is_none());
    }
}
