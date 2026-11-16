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
// The app's fixed streaming query (#344, transcription/deepgram.rs). It is
// recorded in evidence as the request the app sends; the app logs no URL.
export const DEEPGRAM_APP_QUERY =
  'model=nova-3&language=en&encoding=linear16&sample_rate=16000&channels=1&interim_results=true&punctuate=true&diarize=true&endpointing=300&utterance_end_ms=1000&vad_events=true&mip_opt_out=true';
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
  // The grant runs in this process with the real key.
  if (refusedEnvironment(environment)) throw failure('environment');
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
      if (token === null || !isAbsolute(path ?? '')) throw failure('token');
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
        token = null;
        if (!ok)
          try {
            unlinkSync(path);
          } catch {}
      }
      return Object.freeze({ written: true });
    },
    discard() {
      token = null;
    },
  });
}
