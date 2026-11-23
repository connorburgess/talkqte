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

const stored: Record<KeyProvider, string | null> = {
  deepgram: null,
  anthropic: null,
};
const verified: Record<KeyProvider, boolean> = {
  deepgram: false,
  anthropic: false,
};
const rejected: Record<KeyProvider, boolean> = {
  deepgram: false,
  anthropic: false,
};
/** Every argument the notebook sent, for checks of what crossed IPC. */
export const sent: unknown[] = [];
/** Every reply the notebook received. */
export const replies: unknown[] = [];
let usage: CueUsage | null = null;

function keyStatus(provider: KeyProvider): KeyStatus {
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
  };
}

async function changed() {
  const next = status();
  await emit('provider-keys:changed', next);
  return next;
}

export async function command(name: string, args: unknown) {
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
      return changed();
    }
    case 'test_provider_key':
      if (!stored[provider]) throw new Error('No key is set.');
      // Fictional answers: Deepgram accepts, Anthropic refuses.
      if (provider === 'deepgram') verified.deepgram = true;
      else rejected.anthropic = true;
      return changed();
    case 'remove_provider_key':
      stored[provider] = null;
      verified[provider] = false;
      rejected[provider] = false;
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
  setUsage(next: CueUsage | null) {
    usage = next;
  },
  setSessionRunning(running: boolean) {
    sessionRunning = running;
  },
  language: () => language,
};
