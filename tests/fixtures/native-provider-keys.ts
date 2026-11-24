// Fictional provider keys for browser tests: an in-memory stand-in for the
// Keychain commands. It records what the notebook sent and contacts nothing.
import { emit } from '@tauri-apps/api/event';
import type {
  CueUsage,
  KeyProvider,
  KeysStatus,
  KeyStatus,
} from '../../src/lib/providerKeys';

export const commands = [
  'provider_keys_status',
  'set_provider_key',
  'test_provider_key',
  'remove_provider_key',
  'cue_usage',
  'transcription_language',
  'set_transcription_language',
];
let language: 'en' | 'multi' = 'en';
/** Refuse a language change, as the app does while a session runs. */
let sessionRunning = false;

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
  anthropic:
    keysParam === 'set' || keysParam === 'anthropic'
      ? 'sk-ant-api03-fictional-initial-anthropic-key-0123456789'
      : null,
};
const verified: Record<KeyProvider, boolean> = {
  deepgram: false,
  anthropic: false,
};
const rejected: Record<KeyProvider, boolean> = {
  deepgram: false,
  anthropic: false,
};
const unreadable: Record<KeyProvider, boolean> = {
  deepgram: keysParam === 'unreadable' || keysParam === 'unreadable-one',
  anthropic: keysParam === 'unreadable',
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
  const anthropic = keyStatus('anthropic');
  return {
    deepgram,
    anthropic,
    anyMissing: deepgram.state === 'notSet' || anthropic.state === 'notSet',
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
      if (provider === 'anthropic' && !key.startsWith('sk-ant-api'))
        throw new Error(
          'That does not look like an Anthropic API key. It starts with sk-ant-api.',
        );
      if (provider === 'deepgram' && !/^[A-Za-z0-9]{32,128}$/.test(key))
        throw new Error(
          'That does not look like a Deepgram API key. It is letters and digits only.',
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
      // Fictional answers: Deepgram accepts, Anthropic refuses.
      if (provider === 'deepgram') verified.deepgram = true;
      else rejected.anthropic = true;
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
  }
}

export const providerKeysTest = {
  sent,
  replies,
  calls,
  status,
  setUsage(next: CueUsage | null) {
    usage = next;
  },
  setSessionRunning(running: boolean) {
    sessionRunning = running;
  },
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
  async emitStatus(next: KeysStatus) {
    for (const provider of ['deepgram', 'anthropic'] as const) {
      const entry = next[provider];
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
