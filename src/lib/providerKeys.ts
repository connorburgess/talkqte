import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { desktop } from './bridge';

/** The two providers a person brings a key for. */
export type KeyProvider = 'deepgram' | 'anthropic';

/** What the notebook may know about a key; never the key itself. */
export interface KeyStatus {
  /** `unreadable`: the Keychain could not be read, so it is not known. */
  state: 'notSet' | 'set' | 'rejected' | 'unreadable';
  /** The provider accepted it at the last check in this app run. */
  verified: boolean;
}

export interface KeysStatus {
  deepgram: KeyStatus;
  anthropic: KeyStatus;
  /** Either key is not set: what a first-run screen asks for. */
  anyMissing: boolean;
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
  anthropic: null,
};
const previewListeners = new Set<(status: KeysStatus) => void>();

function previewStatus(): KeysStatus {
  const of = (provider: KeyProvider) =>
    previewKeys[provider] ?? { state: 'notSet' as const, verified: false };
  const deepgram = of('deepgram');
  const anthropic = of('anthropic');
  return {
    deepgram,
    anthropic,
    anyMissing: deepgram.state === 'notSet' || anthropic.state === 'notSet',
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
