// Fictional provider keys for browser tests: an in-memory stand-in for the
// Keychain commands. It records what the notebook sent and contacts nothing.
import { emit } from '@tauri-apps/api/event';
import type {
  CueProvider,
  CueUsage,
  KeyProvider,
  KeysStatus,
  KeyStatus,
  ProviderPreferences,
} from '../../src/lib/providerKeys';

// Pure local stand-in constants (do not runtime-import src/lib/* before mockIPC runs).
const CURATED_CUE_MODELS: Record<CueProvider, readonly string[]> = {
  anthropic: ['claude-haiku-5-5', 'claude-sonnet-5-5', 'claude-opus-5-5'],
  openai: ['gpt-5-mini', 'gpt-4.1-mini', 'gpt-4.1', 'gpt-5'],
  gemini: ['gemini-2.5-flash', 'gemini-2.5-flash-lite', 'gemini-2.5-pro'],
};

const CURATED_NOTES_MODELS: Record<CueProvider, readonly string[]> = {
  anthropic: ['claude-opus-5-5', 'claude-sonnet-5-5', 'claude-haiku-5-5'],
  openai: ['gpt-5', 'gpt-4.1', 'gpt-5-mini', 'gpt-4.1-mini'],
  gemini: ['gemini-2.5-pro', 'gemini-2.5-flash', 'gemini-2.5-flash-lite'],
};

export function providerName(provider: CueProvider): string {
  switch (provider) {
    case 'openai':
      return 'OpenAI';
    case 'gemini':
      return 'Gemini';
    default:
      return 'Anthropic';
  }
}

function defaultCueModel(provider: CueProvider): string {
  return CURATED_CUE_MODELS[provider][0];
}

function defaultNotesModel(provider: CueProvider): string {
  return CURATED_NOTES_MODELS[provider][0];
}

function validateModelId(raw: string): string | null {
  if (!raw.trim()) return null;
  const trimmed = raw.replace(/^ +| +$/g, '');
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

export const commands = [
  'provider_keys_status',
  'set_provider_key',
  'test_provider_key',
  'remove_provider_key',
  'cue_usage',
  'transcription_provider',
  'set_transcription_provider',
  'transcription_language',
  'set_transcription_language',
  'provider_preferences',
  'set_cue_provider',
  'set_cue_model_override',
  'set_notes_model_override',
];
let sttProvider: 'deepgram' | 'elevenlabs' = 'deepgram';
let language: 'en' | 'multi' = 'en';
/** Refuse a language or provider/model change, as the app does while a session runs. */
let sessionRunning = false;

let cueProvider: CueProvider = 'anthropic';
let cueModelOverride: string | null = null;
let anthropicNotesModel = 'claude-opus-5-5';
let notesModelOverride: string | null = null;

export function currentPreferences(): ProviderPreferences {
  const effectiveCueModel = cueModelOverride ?? defaultCueModel(cueProvider);
  const fallbackNotes =
    cueProvider === 'anthropic'
      ? anthropicNotesModel
      : defaultNotesModel(cueProvider);
  const effectiveNotesModel = notesModelOverride ?? fallbackNotes;
  const isCuratedCue =
    CURATED_CUE_MODELS[cueProvider].includes(effectiveCueModel);
  const isCuratedNotes =
    CURATED_NOTES_MODELS[cueProvider].includes(effectiveNotesModel);
  return {
    cueProvider,
    cueModelOverride,
    notesModel: effectiveNotesModel,
    notesModelOverride,
    effectiveCueModel,
    effectiveCueCustom: !isCuratedCue,
    effectiveNotesModel,
    effectiveNotesCustom: !isCuratedNotes,
  };
}

export function setCuratedNotesModel(model: string): string {
  const found = CURATED_NOTES_MODELS[cueProvider].includes(model);
  if (!found) throw new Error('That model is not offered.');
  if (cueProvider === 'anthropic') {
    anthropicNotesModel = model;
    notesModelOverride = null;
  } else if (model === defaultNotesModel(cueProvider)) {
    notesModelOverride = null;
  } else {
    notesModelOverride = model;
  }
  return model;
}

const keysParam = new URLSearchParams(location.search).get('keys');
const unavailable = keysParam === 'unavailable';
/** Which platform store answers: the Keychain unless a test names another;
 * `none` is a Linux system with no keyring service. */
const storeParam = new URLSearchParams(location.search).get('store');
const store: NonNullable<KeysStatus['store']> =
  storeParam === 'credentialManager'
    ? { kind: 'credentialManager', available: true }
    : storeParam === 'secretService'
      ? { kind: 'secretService', available: true }
      : storeParam === 'none'
        ? { kind: 'secretService', available: false }
        : { kind: 'keychain', available: true };
const NO_STORE =
  'This system has no keyring TalkQTE can use, so keys cannot be saved here yet. Nothing was changed.';

const stored: Record<KeyProvider, string | null> = {
  deepgram:
    keysParam === 'set' || keysParam === 'deepgram'
      ? 'fictional-initial-deepgram-key-0123456789'
      : null,
  elevenlabs:
    keysParam === 'set' || keysParam === 'elevenlabs'
      ? 'sk_fictionalinitialelevenlabs0123456789abcdef0123'
      : null,
  anthropic:
    keysParam === 'set' || keysParam === 'anthropic'
      ? 'sk-ant-api03-fictional-initial-anthropic-key-0123456789'
      : null,
  openai:
    keysParam === 'openai'
      ? 'sk-proj-fictional-initial-openai-key-0123456789'
      : null,
  gemini:
    keysParam === 'gemini'
      ? 'AIzaFictionalInitialGeminiKey0123456789abcdef'
      : null,
};
const verified: Record<KeyProvider, boolean> = {
  deepgram: false,
  elevenlabs: false,
  anthropic: false,
  openai: false,
  gemini: false,
};
const rejected: Record<KeyProvider, boolean> = {
  deepgram: false,
  elevenlabs: false,
  anthropic: false,
  openai: false,
  gemini: false,
};
const unreadable: Record<KeyProvider, boolean> = {
  deepgram: keysParam === 'unreadable' || keysParam === 'unreadable-one',
  elevenlabs: keysParam === 'unreadable',
  anthropic: keysParam === 'unreadable',
  openai: false,
  gemini: false,
};
type TestOutcome = 'verified' | 'rejected' | { error: string };
const testOverrides: Partial<Record<KeyProvider, TestOutcome>> = {};
let holdTest = false;
let releasePendingTest: (() => void) | undefined;

/** Every argument the notebook sent, for checks of what crossed IPC. */
export const sent: unknown[] = [];
/** Every reply the notebook received. */
export const replies: unknown[] = [];
/** Every command invoked by the notebook, with its provider when present. */
export const calls: { command: string; provider?: KeyProvider }[] = [];
let usage: CueUsage | null = null;

function keyStatus(provider: KeyProvider): KeyStatus {
  if (!store.available || unreadable[provider])
    return { state: 'unreadable', verified: false };
  if (!stored[provider]) return { state: 'notSet', verified: false };
  if (rejected[provider]) return { state: 'rejected', verified: false };
  return { state: 'set', verified: verified[provider] };
}

function status(): KeysStatus {
  const deepgram = keyStatus('deepgram');
  const elevenlabs = keyStatus('elevenlabs');
  const anthropic = keyStatus('anthropic');
  const openai = keyStatus('openai');
  const gemini = keyStatus('gemini');
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
    store,
  };
}

async function changed() {
  const next = status();
  await emit('provider-keys:changed', next);
  return next;
}

export async function command(name: string, args: unknown) {
  const provider = (args as Record<string, string> | undefined)?.provider as
    KeyProvider | undefined;
  calls.push(provider ? { command: name, provider } : { command: name });
  if (unavailable) throw new Error(`Command ${name} not found`);
  sent.push(structuredClone(args ?? null));
  const reply = await answer(name, args as Record<string, string> | undefined);
  replies.push(structuredClone(reply ?? null));
  return reply;
}

async function answer(name: string, args?: Record<string, string>) {
  const provider = args?.provider as KeyProvider;
  switch (name) {
    case 'provider_keys_status':
      return status();
    case 'set_provider_key': {
      if (!store.available) throw new Error(NO_STORE);
      const key = (args?.key ?? '').trim();
      if (
        provider === 'anthropic' &&
        !(
          (key.startsWith('sk-ant-api') || key.startsWith('sk-ant-usr-')) &&
          !key.startsWith('sk-ant-admin') &&
          key.length >= 40 &&
          /^[A-Za-z0-9_-]+$/.test(key)
        )
      )
        throw new Error(
          'That does not look like an Anthropic API key. It starts with sk-ant-api.',
        );
      if (
        provider === 'openai' &&
        !(
          key.startsWith('sk-') &&
          !key.startsWith('sk-ant-') &&
          key.length >= 20 &&
          /^[A-Za-z0-9_-]+$/.test(key)
        )
      )
        throw new Error(
          'That does not look like an OpenAI API key. It starts with sk-.',
        );
      if (
        provider === 'gemini' &&
        !(
          key.startsWith('AIza') &&
          key.length >= 30 &&
          /^[A-Za-z0-9_-]+$/.test(key)
        )
      )
        throw new Error(
          'That does not look like a Google AI Studio Gemini API key. It starts with AIza.',
        );
      if (provider === 'deepgram' && !/^[A-Za-z0-9]{32,128}$/.test(key))
        throw new Error(
          'That does not look like a Deepgram API key. It is letters and digits only.',
        );
      if (
        provider === 'elevenlabs' &&
        !(
          (key.startsWith('sk_') &&
            key.length >= 32 &&
            key.length <= 256 &&
            /^[A-Za-z0-9_-]+$/.test(key)) ||
          (key.length >= 32 && key.length <= 64 && /^[0-9A-Fa-f]+$/.test(key))
        )
      )
        throw new Error(
          'That does not look like an ElevenLabs API key. It starts with sk_ (or is a 32-character hex key).',
        );
      stored[provider] = key;
      verified[provider] = false;
      rejected[provider] = false;
      unreadable[provider] = false;
      return changed();
    }
    case 'test_provider_key': {
      if (holdTest) {
        holdTest = false;
        await new Promise<void>((resolve) => {
          releasePendingTest = resolve;
        });
      }
      if (!stored[provider] && !unreadable[provider])
        throw new Error('No key is set.');
      const override = testOverrides[provider];
      if (override) {
        if (typeof override === 'object') throw new Error(override.error);
        verified[provider] = override === 'verified';
        rejected[provider] = override === 'rejected';
        unreadable[provider] = false;
        return changed();
      }
      // Fictional answers: Deepgram and ElevenLabs accept, cue keys refuse unless overridden.
      if (provider === 'deepgram') verified.deepgram = true;
      else if (provider === 'elevenlabs') verified.elevenlabs = true;
      else rejected[provider] = true;
      return changed();
    }
    case 'remove_provider_key':
      stored[provider] = null;
      verified[provider] = false;
      rejected[provider] = false;
      unreadable[provider] = false;
      return changed();
    case 'cue_usage':
      return usage;
    case 'transcription_provider':
      return sttProvider;
    case 'set_transcription_provider':
      if (sessionRunning)
        throw new Error(
          'Change the transcription provider when no live session is running.',
        );
      if (args?.provider !== 'deepgram' && args?.provider !== 'elevenlabs')
        throw new Error('invalid');
      sttProvider = args.provider;
      return sttProvider;
    case 'transcription_language':
      return language;
    case 'set_transcription_language':
      if (sessionRunning)
        throw new Error(
          'Change the transcription language when no live session is running.',
        );
      if (args?.language !== 'en' && args?.language !== 'multi')
        throw new Error('invalid');
      language = args.language;
      return language;
    case 'provider_preferences':
      return currentPreferences();
    case 'set_cue_provider': {
      if (sessionRunning)
        throw new Error(
          'Change the cue provider when no live session is running.',
        );
      const next = args?.provider as CueProvider;
      if (next !== 'anthropic' && next !== 'openai' && next !== 'gemini')
        throw new Error(`Unsupported cue provider ${String(args?.provider)}.`);
      if (cueProvider !== next) {
        cueProvider = next;
        cueModelOverride = null;
        notesModelOverride = null;
      }
      return currentPreferences();
    }
    case 'set_cue_model_override': {
      if (sessionRunning)
        throw new Error(
          'Change the cue model when no live session is running.',
        );
      cueModelOverride = validateModelId(args?.model ?? '');
      return currentPreferences();
    }
    case 'set_notes_model_override': {
      notesModelOverride = validateModelId(args?.model ?? '');
      return currentPreferences();
    }
  }
}

export type PartialKeysStatus = Partial<KeysStatus> &
  Pick<KeysStatus, 'deepgram' | 'anthropic' | 'anyMissing'>;

export const providerKeysTest = {
  sent,
  replies,
  calls,
  status,
  preferences: currentPreferences,
  providerName,
  setUsage(next: CueUsage | null) {
    usage = next;
  },
  setSessionRunning(running: boolean) {
    sessionRunning = running;
  },
  provider: () => sttProvider,
  language: () => language,
  setTestOutcome(provider: KeyProvider, outcome: TestOutcome) {
    testOverrides[provider] = structuredClone(outcome);
  },
  holdNextTest() {
    holdTest = true;
  },
  releaseTest() {
    const release = releasePendingTest;
    releasePendingTest = undefined;
    release?.();
  },
  async emitStatus(next: PartialKeysStatus) {
    for (const provider of [
      'deepgram',
      'elevenlabs',
      'anthropic',
      'openai',
      'gemini',
    ] as const) {
      const entry = next[provider] ?? { state: 'notSet', verified: false };
      unreadable[provider] = entry.state === 'unreadable';
      rejected[provider] = entry.state === 'rejected';
      verified[provider] = entry.state === 'set' && entry.verified;
      stored[provider] =
        entry.state === 'notSet'
          ? null
          : (stored[provider] ?? `fictional-${provider}-emitted-key`);
    }
    return changed();
  },
};
