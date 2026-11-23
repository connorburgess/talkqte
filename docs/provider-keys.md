# Provider keys

TalkQTE runs on the person's own provider accounts: one Deepgram API key for
transcription and one Anthropic API key for cue decisions. This page describes
how the keys are stored and the commands the notebook uses. In this version
the keys are stored and can be checked, but no session uses them yet.

## Storage

- Keys are kept only in the macOS login Keychain, as generic passwords under
  the service `app.talkqte.provider-key`, with the accounts `deepgram` and
  `anthropic` (`src-tauri/src/provider_keys.rs`). The Keychain encrypts them;
  TalkQTE writes no key to a file.
- A key crosses from the notebook to Rust once, when it is entered. It is never
  sent back to the webview, never logged and never put in an error message;
  its in-memory copy is wiped once used, and its `Debug` form is redacted.
- A key's shape is checked before it is stored. Anthropic: a Console API key
  starting `sk-ant-api` or `sk-ant-usr-` (admin keys and other `sk-ant-`
  credentials are refused), 40 to 256 characters of letters, digits, `-` and
  `_`. Deepgram: 32 to 128 letters and digits. Whitespace around a pasted key
  is removed; anything else is refused without quoting what was pasted.
- Whether a key was checked or rejected is kept in memory for the app run.
- Other platforms have no Keychain: a key is held in memory and is gone at
  quit. The supported app is macOS only.
- macOS may ask the person to allow TalkQTE to use a key it stored, for
  example after a development rebuild changes the app's signature. This has
  not been checked on a signed build.

## Commands

All four are main-window commands and return the same status payload. The
first-run screen reads `provider_keys_status` at launch.

| Command | Arguments | What it does |
| --- | --- | --- |
| `provider_keys_status` | none | Reads which keys are stored. Sends nothing. |
| `set_provider_key` | `{ provider, key }` | Checks the shape, then stores or replaces the key. Sends nothing to the provider. |
| `test_provider_key` | `{ provider }` | One read-only request with the stored key: `GET https://api.deepgram.com/v1/projects` (`Authorization: Token …`) or `GET https://api.anthropic.com/v1/models?limit=1` (`x-api-key`, `anthropic-version: 2026-10-21`). Neither is billed. HTTP 200 marks the key checked; 401 or 403 marks it rejected; anything else is reported as unreachable and changes nothing. The response body is never read. |
| `remove_provider_key` | `{ provider }` | Deletes the key from the Keychain. |

`provider` is `"deepgram"` or `"anthropic"`. The payload:

```json
{
  "deepgram": { "state": "notSet", "verified": false },
  "anthropic": { "state": "set", "verified": true },
  "anyMissing": true
}
```

`state` is `notSet`, `set` or `rejected`. `verified` is true only after a
passing check in this app run, and is cleared when the key is replaced or
rejected. `anyMissing` is true while either key is not set: the "no keys set"
state a first-run screen asks for. A failed command returns one fixed message,
for example "That does not look like an Anthropic API key. It starts with
sk-ant-api." or "Deepgram could not be reached to check the key. Nothing was
changed." After every change the main window also receives
`provider-keys:changed` with the same payload.

## Evidence

Offline Rust tests in `provider_keys` use an in-memory store and a scripted
check. They cover a new install reporting no keys, storing without contacting
the provider, shape refusals, a check sending the key only to its own
provider, rejected and unreachable results, removal, a key found at launch, a
Keychain failure, and redacted debug output. The test build cannot reach the
real Keychain or network. Not yet checked: the real Keychain on a signed
build, and either provider's real response to the check.
