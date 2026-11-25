import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { desktop } from './bridge';

/** The providers a person brings a key for. */
export type KeyProvider = 'deepgram' | 'elevenlabs' | 'anthropic';

/** Which cloud service transcribes live sessions with the person's own key. */
export type TranscriptionProvider = 'deepgram' | 'elevenlabs';

/** What the notebook may know about a key; never the key itself. */
export interface KeyStatus {
  /** `unreadable`: the key store could not be read, so it is not known. */
  state: 'notSet' | 'set' | 'rejected' | 'unreadable';
  /** The provider accepted it at the last check in this app run. */
  verified: boolean;
}

/** The system store that keeps the keys. `memory` is tests only. */
export type KeyStoreKind =
  'keychain' | 'credentialManager' | 'secretService' | 'memory';

export interface KeyStore {
  kind: KeyStoreKind;
  /** False when this system has no such store, so keys cannot be saved. */
  available: boolean;
}

export interface KeysStatus {
  deepgram: KeyStatus;
  elevenlabs?: KeyStatus;
  anthropic: KeyStatus;
  /** No transcription key is set or Anthropic is not set: what a first-run
   * screen asks for. */
  anyMissing: boolean;
  /** Absent only from a payload older than this field. */
  store?: KeyStore;
}

/** How the notebook names each store in a sentence ("kept in …"). */
export function keyStoreName(kind: KeyStoreKind | undefined) {
  switch (kind) {
    case 'credentialManager':
      return 'Windows Credential Manager';
    case 'secretService':
      return 'your desktop keyring';
    case 'memory':
      return 'memory until you quit';
    default:
      return "your Mac's Keychain";
  }
}

/** The short label for a store, as on a setup chip. */
export function keyStoreLabel(kind: KeyStoreKind | undefined) {
  switch (kind) {
    case 'credentialManager':
      return 'Windows Credential Manager';
    case 'secretService':
      return 'Desktop keyring';
    case 'memory':
      return 'Memory only';
    default:
      return 'macOS Keychain';
  }
}

/** This session's use of the Anthropic key; an estimate, not a bill. */
export interface CueUsage {
  model: string;
  requests: number;
  requestCap: number;
  spentMicroUsd: number;
  spendCapMicroUsd: number;
}

// The browser preview keeps fictional keys in memory and contacts nothing.
// Its shape checks mirror src-tauri/src/provider_keys.rs for the preview only;
// the desktop app always checks in Rust.
const previewKeys: Record<KeyProvider, KeyStatus | null> = {
  deepgram: null,
  elevenlabs: null,
  anthropic: null,
};
const previewListeners = new Set<(status: KeysStatus) => void>();

function previewStatus(): KeysStatus {
  const of = (provider: KeyProvider) =>
    previewKeys[provider] ?? { state: 'notSet' as const, verified: false };
  const deepgram = of('deepgram');
  const elevenlabs = of('elevenlabs');
  const anthropic = of('anthropic');
  return {
    deepgram,
    elevenlabs,
    anthropic,
    anyMissing:
      (deepgram.state === 'notSet' && elevenlabs.state === 'notSet') ||
      anthropic.state === 'notSet',
    store: { kind: 'keychain', available: true },
  };
}

function previewShapeError(provider: KeyProvider, text: string) {
  const key = text.trim();
  if (provider === 'anthropic') {
    const ok =
      (key.startsWith('sk-ant-api') || key.startsWith('sk-ant-usr-')) &&
      !key.startsWith('sk-ant-admin') &&
      key.length >= 40 &&
      key.length <= 256 &&
      /^[A-Za-z0-9_-]+$/.test(key);
    return ok
      ? null
      : 'That does not look like an Anthropic API key. It starts with sk-ant-api.';
  }
  if (provider === 'elevenlabs') {
    const ok =
      (key.startsWith('sk_') &&
        key.length >= 32 &&
        key.length <= 256 &&
        /^[A-Za-z0-9_-]+$/.test(key)) ||
      (key.length >= 32 && key.length <= 64 && /^[0-9A-Fa-f]+$/.test(key));
    return ok
      ? null
      : 'That does not look like an ElevenLabs API key. It starts with sk_ (or is a 32-character hex key).';
  }
  return key.length >= 32 && key.length <= 128 && /^[A-Za-z0-9]+$/.test(key)
    ? null
    : 'That does not look like a Deepgram API key. It is letters and digits only.';
}

function previewChanged() {
  const status = previewStatus();
  for (const listener of previewListeners) listener(status);
  return status;
}

export async function keysStatus(): Promise<KeysStatus> {
  if (!desktop) return previewStatus();
  return invoke<KeysStatus>('provider_keys_status');
}

/** Stores or replaces a key. Nothing is sent to the provider. */
export async function setKey(
  provider: KeyProvider,
  key: string,
): Promise<KeysStatus> {
  if (!desktop) {
    const error = previewShapeError(provider, key);
    if (error) throw new Error(error);
    previewKeys[provider] = { state: 'set', verified: false };
    return previewChanged();
  }
  return invoke<KeysStatus>('set_provider_key', { provider, key });
}

/** One read-only request to the provider with the stored key. */
export async function testKey(provider: KeyProvider): Promise<KeysStatus> {
  if (!desktop)
    throw new Error(
      'The browser preview cannot check a key. Nothing was changed.',
    );
  return invoke<KeysStatus>('test_provider_key', { provider });
}

export async function removeKey(provider: KeyProvider): Promise<KeysStatus> {
  if (!desktop) {
    previewKeys[provider] = null;
    return previewChanged();
  }
  return invoke<KeysStatus>('remove_provider_key', { provider });
}

export async function cueUsage(): Promise<CueUsage | null> {
  if (!desktop) return null;
  return invoke<CueUsage | null>('cue_usage');
}

/** Key changes made anywhere in the app, including a first-run screen. */
export async function watchKeys(receive: (status: KeysStatus) => void) {
  if (!desktop) {
    previewListeners.add(receive);
    return () => {
      previewListeners.delete(receive);
    };
  }
  return listen<KeysStatus>('provider-keys:changed', ({ payload }) =>
    receive(payload),
  );
}

/** Which cloud provider transcribes the next live session. */
let previewProvider: TranscriptionProvider = 'deepgram';

export async function transcriptionProvider(): Promise<TranscriptionProvider> {
  if (!desktop) return previewProvider;
  return invoke<TranscriptionProvider>('transcription_provider');
}

/** Applies to the next live session; refused while one is running. */
export async function setTranscriptionProvider(
  provider: TranscriptionProvider,
): Promise<TranscriptionProvider> {
  if (!desktop) {
    previewProvider = provider;
    return previewProvider;
  }
  return invoke<TranscriptionProvider>('set_transcription_provider', {
    provider,
  });
}

/** What the active provider is asked to transcribe in the next live session. */
export type TranscriptionLanguage = 'en' | 'multi';

// The browser preview keeps the choice in memory and sends nothing.
let previewLanguage: TranscriptionLanguage = 'en';

export async function transcriptionLanguage(): Promise<TranscriptionLanguage> {
  if (!desktop) return previewLanguage;
  return invoke<TranscriptionLanguage>('transcription_language');
}

/** Applies to the next live session; refused while one is running. */
export async function setTranscriptionLanguage(
  language: TranscriptionLanguage,
): Promise<TranscriptionLanguage> {
  if (!desktop) {
    previewLanguage = language;
    return previewLanguage;
  }
  return invoke<TranscriptionLanguage>('set_transcription_language', {
    language,
  });
}
