// Frontend bridge for the real provider-key commands from PR #408
// (provider_keys_status, set_provider_key, test_provider_key,
// remove_provider_key, event `provider-keys:changed`) and session usage from
// PR #411 (cue_usage). Until #408 merges into main, missing commands report
// "Unavailable in this build" and never trigger first-run onboarding.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { desktop } from './bridge';

export type Provider = 'deepgram' | 'anthropic';

export type KeyStateValue = 'notSet' | 'set' | 'rejected';

export interface KeyStatus {
  state: KeyStateValue;
  verified: boolean;
}

export interface KeysStatus {
  deepgram: KeyStatus;
  anthropic: KeyStatus;
  anyMissing: boolean;
}

export interface CueUsage {
  model: string;
  requests: number;
  requestCap: number;
  spentMicroUsd: number;
  spendCapMicroUsd: number;
}

export interface ProviderKeysBridge {
  provider_keys_status(): Promise<KeysStatus>;
  set_provider_key(provider: Provider, key: string): Promise<KeysStatus>;
  test_provider_key(provider: Provider): Promise<KeysStatus>;
  remove_provider_key(provider: Provider): Promise<KeysStatus>;
  cue_usage(): Promise<CueUsage | null>;
}

export const PROVIDER_KEYS_CHANGED_EVENT = 'provider-keys:changed';

export const DEFAULT_REQUEST_CAP = 400;
export const DEFAULT_SPEND_CAP_MICRO_USD = 500_000;

export class KeysUnavailableError extends Error {
  constructor() {
    super('Service key commands are unavailable in this build.');
    this.name = 'KeysUnavailableError';
  }
}

export function isUnknownCommandError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '';
  return /\b(?:not found|unknown command|not registered|unhandled)\b/i.test(
    message,
  );
}

function errorText(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (typeof error === 'string') return error;
  return 'The request could not be completed. Nothing was changed.';
}

function isKeyStatus(value: unknown): value is KeyStatus {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    (candidate.state === 'notSet' ||
      candidate.state === 'set' ||
      candidate.state === 'rejected') &&
    typeof candidate.verified === 'boolean'
  );
}

function isKeysStatus(value: unknown): value is KeysStatus {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    isKeyStatus(candidate.deepgram) &&
    isKeyStatus(candidate.anthropic) &&
    typeof candidate.anyMissing === 'boolean'
  );
}

function isCueUsage(value: unknown): value is CueUsage {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.model === 'string' &&
    typeof candidate.requests === 'number' &&
    typeof candidate.requestCap === 'number' &&
    typeof candidate.spentMicroUsd === 'number' &&
    typeof candidate.spendCapMicroUsd === 'number'
  );
}

export const providerKeysBridge: ProviderKeysBridge = {
  async provider_keys_status() {
    if (!desktop) throw new KeysUnavailableError();
    try {
      const result = await invoke<unknown>('provider_keys_status');
      if (!isKeysStatus(result)) throw new KeysUnavailableError();
      return result;
    } catch (error) {
      if (
        error instanceof KeysUnavailableError ||
        isUnknownCommandError(error)
      ) {
        throw new KeysUnavailableError();
      }
      throw error;
    }
  },
  async set_provider_key(provider, key) {
    if (!desktop) throw new KeysUnavailableError();
    try {
      const result = await invoke<unknown>('set_provider_key', {
        provider,
        key,
      });
      if (!isKeysStatus(result)) throw new KeysUnavailableError();
      return result;
    } catch (error) {
      if (
        error instanceof KeysUnavailableError ||
        isUnknownCommandError(error)
      ) {
        throw new KeysUnavailableError();
      }
      throw error;
    }
  },
  async test_provider_key(provider) {
    if (!desktop) throw new KeysUnavailableError();
    try {
      const result = await invoke<unknown>('test_provider_key', { provider });
      if (!isKeysStatus(result)) throw new KeysUnavailableError();
      return result;
    } catch (error) {
      if (
        error instanceof KeysUnavailableError ||
        isUnknownCommandError(error)
      ) {
        throw new KeysUnavailableError();
      }
      throw error;
    }
  },
  async remove_provider_key(provider) {
    if (!desktop) throw new KeysUnavailableError();
    try {
      const result = await invoke<unknown>('remove_provider_key', { provider });
      if (!isKeysStatus(result)) throw new KeysUnavailableError();
      return result;
    } catch (error) {
      if (
        error instanceof KeysUnavailableError ||
        isUnknownCommandError(error)
      ) {
        throw new KeysUnavailableError();
      }
      throw error;
    }
  },
  async cue_usage() {
    if (!desktop) return null;
    try {
      const result = await invoke<unknown>('cue_usage');
      return isCueUsage(result) ? result : null;
    } catch {
      return null;
    }
  },
};

export interface ProviderKeysController {
  loaded: boolean;
  available: boolean;
  status: KeysStatus;
  usage: CueUsage | null;
  checkingProvider: Provider | null;
  busyProvider: Provider | null;
  rowErrors: Record<Provider, string>;
  setKey: (provider: Provider, key: string) => Promise<boolean>;
  testKey: (provider: Provider) => Promise<void>;
  removeKey: (provider: Provider) => Promise<boolean>;
  refresh: () => Promise<void>;
}

const EMPTY_STATUS: KeysStatus = {
  deepgram: { state: 'notSet', verified: false },
  anthropic: { state: 'notSet', verified: false },
  anyMissing: true,
};

const EMPTY_ERRORS: Record<Provider, string> = {
  deepgram: '',
  anthropic: '',
};

export function useProviderKeys(
  bridgeImpl: ProviderKeysBridge = providerKeysBridge,
): ProviderKeysController {
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<KeysStatus>(EMPTY_STATUS);
  const [usage, setUsage] = useState<CueUsage | null>(null);
  const [checkingProvider, setCheckingProvider] = useState<Provider | null>(
    null,
  );
  const [busyProvider, setBusyProvider] = useState<Provider | null>(null);
  const [rowErrors, setRowErrors] =
    useState<Record<Provider, string>>(EMPTY_ERRORS);
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await bridgeImpl.provider_keys_status();
      if (!mounted.current) return;
      setStatus(next);
      setAvailable(true);
      const nextUsage = await bridgeImpl.cue_usage();
      if (mounted.current) setUsage(nextUsage);
    } catch (failure) {
      if (!mounted.current) return;
      if (
        failure instanceof KeysUnavailableError ||
        isUnknownCommandError(failure)
      ) {
        setAvailable(false);
      }
    } finally {
      if (mounted.current) setLoaded(true);
    }
  }, [bridgeImpl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    void listen<unknown>(PROVIDER_KEYS_CHANGED_EVENT, ({ payload }) => {
      if (!disposed && isKeysStatus(payload)) {
        setStatus(payload);
        setAvailable(true);
      }
    })
      .then((unlisten) => {
        if (disposed) unlisten();
        else stop = unlisten;
      })
      .catch(() => {});
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  const setKey = useCallback(
    async (provider: Provider, key: string) => {
      if (!available || !key.trim()) return false;
      setBusyProvider(provider);
      setRowErrors((current) => ({ ...current, [provider]: '' }));
      try {
        const next = await bridgeImpl.set_provider_key(provider, key);
        if (!mounted.current) return false;
        setStatus(next);
        return true;
      } catch (failure) {
        if (!mounted.current) return false;
        if (
          failure instanceof KeysUnavailableError ||
          isUnknownCommandError(failure)
        ) {
          setAvailable(false);
        } else {
          setRowErrors((current) => ({
            ...current,
            [provider]: errorText(failure),
          }));
        }
        return false;
      } finally {
        if (mounted.current) setBusyProvider(null);
      }
    },
    [available, bridgeImpl],
  );

  const testKey = useCallback(
    async (provider: Provider) => {
      if (!available) return;
      setBusyProvider(provider);
      setCheckingProvider(provider);
      setRowErrors((current) => ({ ...current, [provider]: '' }));
      try {
        const next = await bridgeImpl.test_provider_key(provider);
        if (!mounted.current) return;
        setStatus(next);
      } catch (failure) {
        if (!mounted.current) return;
        if (
          failure instanceof KeysUnavailableError ||
          isUnknownCommandError(failure)
        ) {
          setAvailable(false);
        } else {
          setRowErrors((current) => ({
            ...current,
            [provider]: errorText(failure),
          }));
        }
      } finally {
        if (mounted.current) {
          setCheckingProvider(null);
          setBusyProvider(null);
        }
      }
    },
    [available, bridgeImpl],
  );

  const removeKey = useCallback(
    async (provider: Provider) => {
      if (!available) return false;
      setBusyProvider(provider);
      setRowErrors((current) => ({ ...current, [provider]: '' }));
      try {
        const next = await bridgeImpl.remove_provider_key(provider);
        if (!mounted.current) return false;
        setStatus(next);
        return true;
      } catch (failure) {
        if (!mounted.current) return false;
        if (
          failure instanceof KeysUnavailableError ||
          isUnknownCommandError(failure)
        ) {
          setAvailable(false);
        } else {
          setRowErrors((current) => ({
            ...current,
            [provider]: errorText(failure),
          }));
        }
        return false;
      } finally {
        if (mounted.current) setBusyProvider(null);
      }
    },
    [available, bridgeImpl],
  );

  return {
    loaded,
    available,
    status,
    usage,
    checkingProvider,
    busyProvider,
    rowErrors,
    setKey,
    testKey,
    removeKey,
    refresh,
  };
}
