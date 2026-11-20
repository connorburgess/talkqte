//! Opt-in fictional-lab note equality evidence. Never model input or permission.
#![cfg_attr(test, allow(dead_code))]
use crate::cue_evaluator::Failure;
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};

pub(crate) const CONTEXT: &str = "selected-prior-attested-v1";
pub(crate) const POLICY: &str = "fictional-lab-selected-prior-attested-v1";
pub(crate) const WIRE: &str = "talkqte.lab.selected.attested.v1";
pub(crate) const DESCRIPTOR: &str = "talkqte.lab.selected.attested.descriptor.v1";

#[derive(Clone)]
pub(crate) struct Authority {
    pub run_id: String,
    pub expected_count: usize,
    key: [u8; 32],
}
#[derive(Clone, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub(crate) struct Scope {
    pub run_id: String,
    pub session_id: String,
    pub grant_nonce: String,
    pub note_count: usize,
    pub commitment: String,
}
fn bad() -> Failure {
    Failure::InvalidInput
}
fn lp(out: &mut Vec<u8>, bytes: &[u8]) -> Result<(), Failure> {
    let n = u32::try_from(bytes.len()).map_err(|_| bad())?;
    out.extend_from_slice(&n.to_be_bytes());
    out.extend_from_slice(bytes);
    Ok(())
}
fn decode(s: &str) -> Result<[u8; 32], Failure> {
    if s.len() != 64
        || !s
            .bytes()
            .all(|b| b.is_ascii_digit() || (b'a'..=b'f').contains(&b))
    {
        return Err(bad());
    }
    let mut b = [0; 32];
    for (i, v) in b.iter_mut().enumerate() {
        *v = u8::from_str_radix(&s[i * 2..i * 2 + 2], 16).map_err(|_| bad())?;
    }
    Ok(b)
}
fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub(crate) fn equivalent(a: &str, b: &str) -> bool {
    match (decode(a), decode(b)) {
        (Ok(a), Ok(b)) => a.iter().zip(b).fold(0u8, |v, (x, y)| v | (x ^ y)) == 0,
        _ => false,
    }
}
pub(crate) fn projection(sources: &[crate::cue_evaluator::Source]) -> Value {
    use crate::cue_evaluator::Provenance;
    Value::Array(sources.iter().filter_map(|s|match &s.provenance { Provenance::PriorNote{provider,date,title}=>Some(serde_json::json!({"id":s.id,"provider":provider.id(),"title":title,"date":date,"snapshotRevision":s.revision.to_string(),"freshness":"not_verified","text":s.text})),_=>None }).collect())
}
pub(crate) fn message(scope: &Scope, notes: &Value) -> Result<Vec<u8>, Failure> {
    let session = scope.session_id.parse::<u64>().map_err(|_| bad())?;
    if session.to_string() != scope.session_id
        || scope.run_id.is_empty()
        || scope.run_id.len() > 64
        || !scope
            .run_id
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_')
    {
        return Err(bad());
    }
    let nonce = decode(&scope.grant_nonce)?;
    let mut out = Vec::new();
    for field in [
        b"talkqte.selected-note-attestation".as_slice(),
        b"1",
        scope.run_id.as_bytes(),
        scope.session_id.as_bytes(),
        &nonce,
        POLICY.as_bytes(),
    ] {
        lp(&mut out, field)?;
    }
    lp(&mut out, b"selected-note-projection-v1")?;
    let mut notes: Vec<_> = notes.as_array().ok_or_else(bad)?.iter().collect();
    if notes.len() > 20 {
        return Err(bad());
    }
    notes.sort_by(|a, b| a["id"].as_str().cmp(&b["id"].as_str()));
    out.extend_from_slice(&(notes.len() as u32).to_be_bytes());
    let mut previous = None;
    for note in notes {
        let id = note["id"].as_str().ok_or_else(bad)?;
        if previous == Some(id) {
            return Err(bad());
        }
        previous = Some(id);
        for field in [
            "id",
            "provider",
            "title",
            "date",
            "snapshotRevision",
            "freshness",
            "text",
        ] {
            lp(&mut out, note[field].as_str().ok_or_else(bad)?.as_bytes())?;
        }
    }
    Ok(out)
}
impl Authority {
    pub(crate) fn commitment(&self, scope: &Scope, notes: &Value) -> Result<String, Failure> {
        if scope.note_count != self.expected_count
            || scope.run_id != self.run_id
            || notes.as_array().ok_or_else(bad)?.len() != self.expected_count
        {
            return Err(bad());
        }
        let bytes = message(scope, notes)?;
        // RFC2104 HMAC-SHA256; this contract's key is exactly32 bytes (one block).
        let mut inner = [0x36u8; 64];
        let mut outer = [0x5cu8; 64];
        for i in 0..32 {
            inner[i] ^= self.key[i];
            outer[i] ^= self.key[i];
        }
        let mut hash = Sha256::new();
        hash.update(inner);
        hash.update(bytes);
        let inside = hash.finalize();
        let mut hash = Sha256::new();
        hash.update(outer);
        hash.update(inside);
        Ok(hex(&hash.finalize()))
    }
    pub(crate) fn scope(&self, session: u64, notes: &Value) -> Result<Scope, Failure> {
        let mut nonce = [0; 32];
        getrandom::fill(&mut nonce).map_err(|_| bad())?;
        let mut scope = Scope {
            run_id: self.run_id.clone(),
            session_id: session.to_string(),
            grant_nonce: hex(&nonce),
            note_count: self.expected_count,
            commitment: String::new(),
        };
        scope.commitment = self.commitment(&scope, notes)?;
        Ok(scope)
    }
}
#[cfg(unix)]
pub(crate) fn read(path: &std::path::Path) -> Result<Authority, Failure> {
    use std::{
        fs::{self, OpenOptions},
        io::Read,
        os::unix::fs::{MetadataExt, OpenOptionsExt},
    };
    if !path.is_absolute() {
        return Err(bad());
    }
    let dir = fs::symlink_metadata(path.parent().ok_or_else(bad)?).map_err(|_| bad())?;
    // SAFETY: geteuid is a side-effect-free process query.
    let uid = unsafe { libc::geteuid() };
    if !dir.is_dir() || dir.uid() != uid || dir.mode() & 0o777 != 0o700 {
        return Err(bad());
    }
    let mut file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| bad())?;
    let meta = file.metadata().map_err(|_| bad())?;
    if !meta.is_file()
        || meta.nlink() != 1
        || meta.uid() != uid
        || meta.mode() & 0o777 != 0o600
        || meta.len() > 4096
    {
        return Err(bad());
    }
    let mut bytes = Vec::new();
    file.by_ref()
        .take(4097)
        .read_to_end(&mut bytes)
        .map_err(|_| bad())?;
    if bytes.len() > 4096 {
        return Err(bad());
    }
    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase", deny_unknown_fields)]
    struct Wire {
        schema: String,
        run_id: String,
        expected_count: usize,
        key: String,
    }
    let wire: Wire = serde_json::from_slice(&bytes).map_err(|_| bad())?;
    if wire.schema != "talkqte.lab.scope-authority.v1" || wire.expected_count > 1 {
        return Err(bad());
    }
    Ok(Authority {
        run_id: wire.run_id,
        expected_count: wire.expected_count,
        key: decode(&wire.key)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn shared_complete_envelope_bytes_and_hmac_match_exactly() {
        let vectors: Value = serde_json::from_str(include_str!(
            "../../scripts/fixtures/selected-attestation-vectors.json"
        ))
        .unwrap();
        for vector in vectors.as_array().unwrap() {
            let scope: Scope = serde_json::from_value(vector["scope"].clone()).unwrap();
            let a = Authority {
                run_id: scope.run_id.clone(),
                expected_count: scope.note_count,
                key: decode(vector["keyHex"].as_str().unwrap()).unwrap(),
            };
            assert_eq!(
                hex(&message(&scope, &vector["notes"]).unwrap()),
                vector["messageHex"]
            );
            assert_eq!(
                a.commitment(&scope, &vector["notes"]).unwrap(),
                vector["digest"]
            );
            let mut wrong = scope.clone();
            wrong.session_id = "07".into();
            assert!(a.commitment(&wrong, &vector["notes"]).is_err());
            wrong = scope.clone();
            wrong.grant_nonce = "A".repeat(64);
            assert!(a.commitment(&wrong, &vector["notes"]).is_err());
        }
    }
    #[test]
    fn observed_scope_mutation_and_empty_selected_are_refused() {
        let a = Authority {
            run_id: "fictional".into(),
            expected_count: 1,
            key: [7; 32],
        };
        let notes = serde_json::json!([{"id":"prior:file:a","provider":"file","title":"Workshop","date":"2026-10-20","snapshotRevision":"1","freshness":"not_verified","text":"Exact retained copy."}]);
        let scope = a.scope(7, &notes).unwrap();
        assert!(equivalent(
            &scope.commitment,
            &a.commitment(&scope, &notes).unwrap()
        ));
        assert!(a.commitment(&scope, &serde_json::json!([])).is_err());
        let mut changed = notes.clone();
        changed[0]["text"] = serde_json::json!("Changed retained copy.");
        assert!(!equivalent(
            &scope.commitment,
            &a.commitment(&scope, &changed).unwrap()
        ));
    }
}
