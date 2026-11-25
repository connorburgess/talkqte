import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { desktop } from './bridge';

/** The providers a person brings a key for. */
export type KeyProvider =
  'deepgram' | 'elevenlabs' | 'anthropic' | 'openai' | 'gemini';

/** Which cloud service transcribes live sessions with the person's own key. */
export type TranscriptionProvider = 'deepgram' | 'elevenlabs';

/** The providers supported for cue decisions and meeting notes. */
export type CueProvider = 'anthropic' | 'openai' | 'gemini';

export function cueProviderName(provider: CueProvider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'gemini':
      return 'Gemini';
    default:
      return 'Anthropic';
  }
}

export const CURATED_CUE_MODELS: Record<
  CueProvider,
  readonly { id: string; label: string }[]
> = {
  anthropic: [
    { id: 'claude-haiku-5-5', label: 'claude-haiku-5-5 (tested default)' },
    { id: 'claude-sonnet-5-5', label: 'claude-sonnet-5-5' },
    { id: 'claude-opus-5-5', label: 'claude-opus-5-5' },
  ],
  openai: [
    { id: 'gpt-5-mini', label: 'gpt-5-mini (tested default)' },
    { id: 'gpt-4.1-mini', label: 'gpt-4.1-mini' },
    { id: 'gpt-4.1', label: 'gpt-4.1' },
    { id: 'gpt-5', label: 'gpt-5' },
  ],
  gemini: [
    { id: 'gemini-2.5-flash', label: 'gemini-2.5-flash (tested default)' },
    { id: 'gemini-2.5-flash-lite', label: 'gemini-2.5-flash-lite' },
    { id: 'gemini-2.5-pro', label: 'gemini-2.5-pro' },
  ],
};

export function defaultCueModel(provider: CueProvider): string {
  return CURATED_CUE_MODELS[provider][0].id;
}

export function defaultNotesModelFor(provider: CueProvider): string {
  switch (provider) {
    case 'openai':
      return 'gpt-5';
    case 'gemini':
      return 'gemini-2.5-pro';
    default:
      return 'claude-opus-5-5';
  }
}

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
  openai: KeyStatus;
  gemini: KeyStatus;
  /** True when no transcription key is set or no cue provider key is set:
   * what a first-run screen asks for. */
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

/** This session's use of the active cue key; spend fields are null for custom models. */
export interface CueUsage {
  provider?: CueProvider;
  model: string;
  requests: number;
  requestCap: number;
  spentMicroUsd: number | null;
  spendCapMicroUsd: number | null;
  customModel?: boolean;
}

export interface ProviderPreferences {
  cueProvider: CueProvider;
  cueModelOverride: string | null;
  notesModel: string;
  notesModelOverride: string | null;
  effectiveCueModel: string;
  effectiveCueCustom: boolean;
  effectiveNotesModel: string;
  effectiveNotesCustom: boolean;
}

// The browser preview keeps fictional keys in memory and contacts nothing.
// Its shape checks mirror src-tauri/src/provider_keys.rs for the preview only;
// the desktop app always checks in Rust.
const previewKeys: Record<KeyProvider, KeyStatus | null> = {
  deepgram: null,
  elevenlabs: null,
  anthropic: null,
  openai: null,
  gemini: null,
};
const previewListeners = new Set<(status: KeysStatus) => void>();
const previewPrefListeners = new Set<(prefs: ProviderPreferences) => void>();

let previewPrefs: {
  cueProvider: CueProvider;
  cueModelOverride: string | null;
  anthropicNotesModel: string;
  notesModelOverride: string | null;
} = {
  cueProvider: 'anthropic',
  cueModelOverride: null,
  anthropicNotesModel: 'claude-opus-5-5',
  notesModelOverride: null,
};

function isCuratedCue(provider: CueProvider, id: string) {
  return CURATED_CUE_MODELS[provider].some((m) => m.id === id);
}

function isCuratedNotes(provider: CueProvider, id: string) {
  const curated: Record<CueProvider, string[]> = {
    anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
    openai: ['gpt-5', 'gpt-4.1', 'gpt-5-mini', 'gpt-4.1-mini'],
    gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
  };
  return curated[provider].includes(id);
}

function currentPreviewPrefs(): ProviderPreferences {
  const provider = previewPrefs.cueProvider;
  const effectiveCueModel =
    previewPrefs.cueModelOverride ?? defaultCueModel(provider);
  const fallbackNotes =
    provider === 'anthropic'
      ? previewPrefs.anthropicNotesModel
      : defaultNotesModelFor(provider);
  const effectiveNotesModel = previewPrefs.notesModelOverride ?? fallbackNotes;
  return {
    cueProvider: provider,
    cueModelOverride: previewPrefs.cueModelOverride,
    notesModel: effectiveNotesModel,
    notesModelOverride: previewPrefs.notesModelOverride,
    effectiveCueModel,
    effectiveCueCustom: !isCuratedCue(provider, effectiveCueModel),
    effectiveNotesModel,
    effectiveNotesCustom: !isCuratedNotes(provider, effectiveNotesModel),
  };
}

function notifyPreviewPrefs(): ProviderPreferences {
  const next = currentPreviewPrefs();
  for (const listener of previewPrefListeners) listener(next);
  return next;
}

export function validateModelId(raw: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (
    trimmed.length > 96 ||
    trimmed.includes('..') ||
    !/^[A-Za-z0-9._:/-]+$/.test(trimmed)
  ) {
    throw new Error(
      'Model ID must be up to 96 ASCII characters (letters, digits, ., _, :, /, -).',
    );
  }
  return trimmed;
}

function previewStatus(): KeysStatus {
  const of = (provider: KeyProvider) =>
    previewKeys[provider] ?? { state: 'notSet' as const, verified: false };
  const deepgram = of('deepgram');
  const elevenlabs = of('elevenlabs');
  const anthropic = of('anthropic');
  const openai = of('openai');
  const gemini = of('gemini');
  const sttMissing =
    deepgram.state === 'notSet' && elevenlabs.state === 'notSet';
  const cueMissing =
    anthropic.state === 'notSet' &&
    openai.state === 'notSet' &&
    gemini.state === 'notSet';
  return {
    deepgram,
    elevenlabs,
    anthropic,
    openai,
    gemini,
    anyMissing: sttMissing || cueMissing,
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
  if (provider === 'openai') {
    const ok =
      key.startsWith('sk-') &&
      !key.startsWith('sk-ant-') &&
      key.length >= 20 &&
      key.length <= 256 &&
      /^[A-Za-z0-9_-]+$/.test(key);
    return ok
      ? null
      : 'That does not look like an OpenAI API key. It starts with sk-.';
  }
  if (provider === 'gemini') {
    const ok =
      key.startsWith('AIza') &&
      key.length >= 30 &&
      key.length <= 128 &&
      /^[A-Za-z0-9_-]+$/.test(key);
    return ok
      ? null
      : 'That does not look like a Gemini API key. It starts with AIza.';
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

export async function providerPreferences(): Promise<ProviderPreferences> {
  if (!desktop) return currentPreviewPrefs();
  return invoke<ProviderPreferences>('provider_preferences');
}

export async function setCueProvider(
  provider: CueProvider,
): Promise<ProviderPreferences> {
  if (!desktop) {
    if (previewPrefs.cueProvider !== provider) {
      previewPrefs.cueProvider = provider;
      previewPrefs.cueModelOverride = null;
      previewPrefs.notesModelOverride = null;
    }
    return notifyPreviewPrefs();
  }
  return invoke<ProviderPreferences>('set_cue_provider', { provider });
}

export async function setCueModelOverride(
  model: string | null,
): Promise<ProviderPreferences> {
  if (!desktop) {
    previewPrefs.cueModelOverride = model ? validateModelId(model) : null;
    return notifyPreviewPrefs();
  }
  return invoke<ProviderPreferences>('set_cue_model_override', { model });
}

export async function setNotesModelOverride(
  model: string | null,
): Promise<ProviderPreferences> {
  if (!desktop) {
    previewPrefs.notesModelOverride = model ? validateModelId(model) : null;
    return notifyPreviewPrefs();
  }
  return invoke<ProviderPreferences>('set_notes_model_override', { model });
}

export function watchPreviewPreferences(
  receive: (prefs: ProviderPreferences) => void,
) {
  previewPrefListeners.add(receive);
  return () => {
    previewPrefListeners.delete(receive);
  };
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
