// Typed frontend stub for the ServiceKeysBridge Tauri commands (keys_status,
// keys_set, keys_test, keys_remove, and optional keys_session_usage).
// The own-key lane's first PR implements these commands in Rust and replaces
// this stub's fallback behavior. Until then, missing commands report
// "Unavailable in this build" and never trigger first-run onboarding.
import { useCallback, useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { desktop } from './bridge';

export type KeyProvider = 'deepgram' | 'anthropic';

export type KeyState =
  | { status: 'not_set' }
  | { status: 'set' }
  | { status: 'checking' }
  | {
      status: 'rejected';
      reason: 'refused' | 'unreachable';
      message: string;
    };

export interface KeysStatusSnapshot {
  deepgram: KeyState;
  anthropic: KeyState;
}

export interface SessionUsageSnapshot {
  anthropicRequests: number;
  anthropicCap: number;
  estimatedSpendUsd: number;
  active: boolean;
}

export interface ServiceKeysBridge {
  keys_status(): Promise<KeysStatusSnapshot>;
  keys_set(provider: KeyProvider, secret: string): Promise<KeyState>;
  keys_test(provider: KeyProvider): Promise<KeyState>;
  keys_remove(provider: KeyProvider): Promise<KeyState>;
  keys_session_usage?(): Promise<SessionUsageSnapshot>;
}

export type KeysLoadResult =
  { available: true; status: KeysStatusSnapshot } | { available: false };

export const DEFAULT_SESSION_USAGE: SessionUsageSnapshot = {
  anthropicRequests: 0,
  anthropicCap: 40,
  estimatedSpendUsd: 0,
  active: false,
};

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

function isKeyState(value: unknown): value is KeyState {
  if (!value || typeof value !== 'object') return false;
  const status = (value as { status?: unknown }).status;
  return (
    status === 'not_set' ||
    status === 'set' ||
    status === 'checking' ||
    status === 'rejected'
  );
}

function isKeysStatusSnapshot(value: unknown): value is KeysStatusSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return isKeyState(candidate.deepgram) && isKeyState(candidate.anthropic);
}

function isSessionUsageSnapshot(value: unknown): value is SessionUsageSnapshot {
  if (!value || typeof value !== 'object') return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.anthropicRequests === 'number' &&
    typeof candidate.anthropicCap === 'number' &&
    typeof candidate.estimatedSpendUsd === 'number' &&
    typeof candidate.active === 'boolean'
  );
}

export const serviceKeysBridge: ServiceKeysBridge = {
  async keys_status() {
    if (!desktop) throw new KeysUnavailableError();
    try {
      const result = await invoke<unknown>('keys_status');
      if (!isKeysStatusSnapshot(result)) throw new KeysUnavailableError();
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
  async keys_set(provider, secret) {
    if (!desktop) throw new KeysUnavailableError();
    try {
      const result = await invoke<unknown>('keys_set', { provider, secret });
      if (!isKeyState(result)) throw new KeysUnavailableError();
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
  async keys_test(provider) {
    if (!desktop) throw new KeysUnavailableError();
    try {
      const result = await invoke<unknown>('keys_test', { provider });
      if (!isKeyState(result)) throw new KeysUnavailableError();
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
  async keys_remove(provider) {
    if (!desktop) throw new KeysUnavailableError();
    try {
      const result = await invoke<unknown>('keys_remove', { provider });
      if (!isKeyState(result)) throw new KeysUnavailableError();
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
  async keys_session_usage() {
    if (!desktop) return DEFAULT_SESSION_USAGE;
    try {
      const result = await invoke<unknown>('keys_session_usage');
      return isSessionUsageSnapshot(result) ? result : DEFAULT_SESSION_USAGE;
    } catch {
      return DEFAULT_SESSION_USAGE;
    }
  },
};

export interface ServiceKeysController {
  loaded: boolean;
  available: boolean;
  status: KeysStatusSnapshot;
  usage: SessionUsageSnapshot;
  busyProvider: KeyProvider | null;
  error: string;
  setKey: (provider: KeyProvider, secret: string) => Promise<boolean>;
  testKey: (provider: KeyProvider) => Promise<void>;
  removeKey: (provider: KeyProvider) => Promise<boolean>;
  refresh: () => Promise<void>;
}

const EMPTY_STATUS: KeysStatusSnapshot = {
  deepgram: { status: 'not_set' },
  anthropic: { status: 'not_set' },
};

export function useServiceKeys(
  bridgeImpl: ServiceKeysBridge = serviceKeysBridge,
): ServiceKeysController {
  const [loaded, setLoaded] = useState(false);
  const [available, setAvailable] = useState(false);
  const [status, setStatus] = useState<KeysStatusSnapshot>(EMPTY_STATUS);
  const [usage, setUsage] = useState<SessionUsageSnapshot>(
    DEFAULT_SESSION_USAGE,
  );
  const [busyProvider, setBusyProvider] = useState<KeyProvider | null>(null);
  const [error, setError] = useState('');
  const mounted = useRef(true);

  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
    };
  }, []);

  const refresh = useCallback(async () => {
    try {
      const next = await bridgeImpl.keys_status();
      if (!mounted.current) return;
      setStatus(next);
      setAvailable(true);
      setError('');
      if (bridgeImpl.keys_session_usage) {
        const nextUsage = await bridgeImpl.keys_session_usage();
        if (mounted.current) setUsage(nextUsage);
      }
    } catch (failure) {
      if (!mounted.current) return;
      if (
        failure instanceof KeysUnavailableError ||
        isUnknownCommandError(failure)
      ) {
        setAvailable(false);
        setError('');
      } else {
        setError(failure instanceof Error ? failure.message : String(failure));
      }
    } finally {
      if (mounted.current) setLoaded(true);
    }
  }, [bridgeImpl]);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  const setKey = useCallback(
    async (provider: KeyProvider, secret: string) => {
      if (!available || !secret.trim()) return false;
      setBusyProvider(provider);
      setError('');
      try {
        const next = await bridgeImpl.keys_set(provider, secret);
        if (!mounted.current) return false;
        setStatus((current) => ({ ...current, [provider]: next }));
        return true;
      } catch (failure) {
        if (!mounted.current) return false;
        if (
          failure instanceof KeysUnavailableError ||
          isUnknownCommandError(failure)
        ) {
          setAvailable(false);
        } else {
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
        }
        return false;
      } finally {
        if (mounted.current) setBusyProvider(null);
      }
    },
    [available, bridgeImpl],
  );

  const testKey = useCallback(
    async (provider: KeyProvider) => {
      if (!available) return;
      setBusyProvider(provider);
      setError('');
      setStatus((current) => ({
        ...current,
        [provider]: { status: 'checking' },
      }));
      try {
        const next = await bridgeImpl.keys_test(provider);
        if (!mounted.current) return;
        setStatus((current) => ({ ...current, [provider]: next }));
      } catch (failure) {
        if (!mounted.current) return;
        if (
          failure instanceof KeysUnavailableError ||
          isUnknownCommandError(failure)
        ) {
          setAvailable(false);
        } else {
          setStatus((current) => ({
            ...current,
            [provider]: {
              status: 'rejected',
              reason: 'unreachable',
              message:
                failure instanceof Error
                  ? failure.message
                  : 'Could not reach the service.',
            },
          }));
        }
      } finally {
        if (mounted.current) setBusyProvider(null);
      }
    },
    [available, bridgeImpl],
  );

  const removeKey = useCallback(
    async (provider: KeyProvider) => {
      if (!available) return false;
      setBusyProvider(provider);
      setError('');
      try {
        const next = await bridgeImpl.keys_remove(provider);
        if (!mounted.current) return false;
        setStatus((current) => ({ ...current, [provider]: next }));
        return true;
      } catch (failure) {
        if (!mounted.current) return false;
        if (
          failure instanceof KeysUnavailableError ||
          isUnknownCommandError(failure)
        ) {
          setAvailable(false);
        } else {
          setError(
            failure instanceof Error ? failure.message : String(failure),
          );
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
    busyProvider,
    error,
    setKey,
    testKey,
    removeKey,
    refresh,
  };
}
