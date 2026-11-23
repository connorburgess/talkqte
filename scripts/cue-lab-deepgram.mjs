// Deepgram grant for a lab run's cloud transcription. The owner's key is
// read from a private file and used once, in this process, to mint a
// short-lived token; neither ever reaches argv, the environment, a log,
// evidence or an error. The token stays in a closure until the launcher
// writes it to an owner-only file that the app reads at approval, and that
// the launcher deletes at run end.
import {
  closeSync,
  constants,
  fstatSync,
  lstatSync,
  openSync,
  unlinkSync,
  writeSync,
} from 'node:fs';
import { dirname, isAbsolute, join } from 'node:path';
import {
  LAB_KEY_DIR,
  readLabKeyFile,
  refusedEnvironment,
} from './cue-lab-key-file.mjs';

export const DEEPGRAM_KEY_NAME = 'TALKQTE_LAB_DEEPGRAM_KEY';
export const DEEPGRAM_KEY_FILE = join(LAB_KEY_DIR, 'deepgram.env');
export const DEEPGRAM_GRANT_URL = 'https://api.deepgram.com/v1/auth/grant';
// Long enough to outlive launch, Listening and the 180 s approval wait: the
// app reads the token only when the stream opens, at approval.
export const DEEPGRAM_GRANT_TTL_S = 900;
// The app's two fixed streaming queries (transcription/deepgram.rs): English
// (#344), and Multilingual (`language=multi`, with the 100 ms endpointing
// Deepgram recommends for code-switching). One is recorded in evidence as the
// request the app sends; the app logs no URL. A plan keeps English unless its
// `transcription.language` is `multi`.
export const DEEPGRAM_APP_QUERY =
  'model=nova-3&language=en&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&diarize=true&endpointing=300&utterance_end_ms=1000&vad_events=true&mip_opt_out=true';
export const DEEPGRAM_APP_QUERY_MULTI =
  'model=nova-3&language=multi&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&diarize=true&endpointing=100&utterance_end_ms=1000&vad_events=true&mip_opt_out=true';
export const DEEPGRAM_APP_QUERIES = Object.freeze({
  en: DEEPGRAM_APP_QUERY,
  multi: DEEPGRAM_APP_QUERY_MULTI,
});
/** The app's query for a plan's language; anything but `en` or `multi` is
 * refused. */
export function deepgramAppQuery(language = 'en') {
  if (!Object.hasOwn(DEEPGRAM_APP_QUERIES, language))
    throw new Error('invalid transcription language');
  return DEEPGRAM_APP_QUERIES[language];
}
/** Exactly one of the app's two queries, and nothing else. */
export function isAppQuery(query) {
  return Object.values(DEEPGRAM_APP_QUERIES).includes(query);
}
// A query the app may report on its `connected` row: plain `name=value`
// pairs whose names are only those of the app's own query (an allowlist, so
// no other parameter, however named, can carry a value into evidence).
const QUERY_NAMES = new Set(
  DEEPGRAM_APP_QUERY.split('&').map((pair) => pair.split('=')[0]),
);
export function isAllowedSttQuery(query) {
  if (typeof query !== 'string' || !query || query.length > 1024) return false;
  const seen = new Set();
  return query.split('&').every((pair) => {
    const m = pair.match(/^([a-z_]+)=([A-Za-z0-9_.-]{1,40})$/);
    if (!m || !QUERY_NAMES.has(m[1]) || seen.has(m[1])) return false;
    seen.add(m[1]);
    return true;
  });
}
// What the app accepts in its token file.
const TOKEN = /^[A-Za-z0-9._-]{20,4096}$/;

const failure = (category) =>
  Object.assign(new Error(`Lab transcription grant stopped: ${category}.`), {
    category,
  });

export function readDeepgramKeyFile({ file = DEEPGRAM_KEY_FILE } = {}) {
  return readLabKeyFile({
    file,
    name: DEEPGRAM_KEY_NAME,
    accept: (value) => /^[A-Za-z0-9]{20,128}$/.test(value),
  });
}

/**
 * Mints one grant. Returns a frozen handle with the TTL and a one-time
 * `writeTokenFile(path)`; the token is never a property. `offline` is for
 * tests only: a loopback endpoint and a dummy key.
 */
export async function mintDeepgramGrant({
  ttlSeconds = DEEPGRAM_GRANT_TTL_S,
  keyFile,
  fetch: customFetch,
  offline,
  timeoutMs = 10000,
  environment = process.env,
} = {}) {
  if (
    !Number.isSafeInteger(ttlSeconds) ||
    ttlSeconds < 300 ||
    ttlSeconds > 3600 ||
    // A substitute fetch only with the offline stand-in, never the real key.
    (customFetch !== undefined &&
      (!offline || typeof customFetch !== 'function'))
  )
    throw failure('configuration');
  // The grant runs in this process with the real key, so this process's own
  // environment is always checked, whatever the caller passes.
  if (refusedEnvironment(process.env) || refusedEnvironment(environment))
    throw failure('environment');
  const fetch = customFetch ?? globalThis.fetch;
  let key, url;
  if (offline) {
    if (
      !/^http:\/\/127\.0\.0\.1:[1-9][0-9]*$/.test(offline.baseUrl ?? '') ||
      !/^offline[a-z0-9]{13,40}$/.test(offline.key ?? '')
    )
      throw failure('configuration');
    key = offline.key;
    url = `${offline.baseUrl}/v1/auth/grant`;
  } else {
    try {
      key = readDeepgramKeyFile(keyFile ? { file: keyFile } : {});
    } catch {
      throw failure('credentials');
    }
    url = DEEPGRAM_GRANT_URL;
  }
  let response, body;
  try {
    response = await fetch(url, {
      method: 'POST',
      headers: {
        authorization: `Token ${key}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({ ttl_seconds: ttlSeconds }),
      redirect: 'error',
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch {
    throw failure('network');
  } finally {
    key = null;
  }
  // A refused key, unpaid account or rate limit stops the run; so does any
  // other status. No response body is ever read into an error.
  if (response.status !== 200) {
    await response.body?.cancel().catch(() => {});
    throw failure(
      { 401: 'auth', 403: 'auth', 402: 'quota', 429: 'rate-limited' }[
        response.status
      ] ?? 'provider',
    );
  }
  try {
    const text = await response.text();
    if (text.length > 16384) throw new Error();
    body = JSON.parse(text);
  } catch {
    throw failure('protocol');
  }
  let token = body?.access_token;
  const expiresIn = body?.expires_in;
  if (
    typeof token !== 'string' ||
    !TOKEN.test(token) ||
    !Number.isSafeInteger(expiresIn) ||
    expiresIn < 300 ||
    expiresIn > ttlSeconds
  )
    throw failure('protocol');
  body = null;
  return Object.freeze({
    ttlSeconds,
    expiresInS: expiresIn,
    /**
     * Writes the token, once, to a new 0600 regular file in an existing
     * owner-only 0700 directory, exactly as the app reads it.
     */
    writeTokenFile(path) {
      if (token === null) throw failure('token');
      const value = token;
      token = null;
      return writeOwnerOnlyToken(path, value);
    },
    discard() {
      token = null;
    },
  });
}

// Writes a token, once, to a new 0600 regular file in an existing owner-only
// 0700 directory, exactly as the app reads it.
function writeOwnerOnlyToken(path, token) {
  if (!isAbsolute(path ?? '') || !TOKEN.test(token)) throw failure('token');
  const uid = process.getuid?.();
  const dir = lstatSync(dirname(path));
  if (
    !dir.isDirectory() ||
    dir.isSymbolicLink() ||
    dir.uid !== uid ||
    (dir.mode & 0o777) !== 0o700
  )
    throw failure('token');
  const fd = openSync(
    path,
    constants.O_WRONLY |
      constants.O_CREAT |
      constants.O_EXCL |
      constants.O_NOFOLLOW,
    0o600,
  );
  let ok = false;
  try {
    const bytes = Buffer.from(token, 'utf8');
    if (writeSync(fd, bytes) !== bytes.length) throw failure('token');
    const written = fstatSync(fd);
    if (
      !written.isFile() ||
      written.uid !== uid ||
      (written.mode & 0o777) !== 0o600 ||
      written.size !== bytes.length
    )
      throw failure('token');
    ok = true;
  } finally {
    closeSync(fd);
    if (!ok)
      try {
        unlinkSync(path);
      } catch {}
  }
  return Object.freeze({ written: true });
}

// A deliberate provider-failure take (T5). The launcher, never a caller,
// writes this fixed text where a token would go. It has the token file's
// shape, so the app's own checks accept the file and the app connects as
// usual, but it is no credential: it is not a Deepgram grant (a JWT has
// dots), so Deepgram refuses it and the app's refusal path runs (expected
// code `auth`). No key file is read, nothing is minted, and the probe
// cannot carry a real token because it takes no grant at all.
export const REFUSED_TOKEN_PROBE = 'refused-token';
export const REFUSED_PROBE_TOKEN =
  'talkqte-lab-refused-token-probe-not-a-credential';
export function refusedTokenProbe() {
  let used = false;
  return Object.freeze({
    probe: REFUSED_TOKEN_PROBE,
    ttlSeconds: null,
    writeTokenFile(path) {
      if (used) throw failure('token');
      used = true;
      return writeOwnerOnlyToken(path, REFUSED_PROBE_TOKEN);
    },
    discard() {
      used = true;
    },
  });
}
