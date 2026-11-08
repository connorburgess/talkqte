import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { desktop } from './bridge';

export interface MicrophoneSnapshot {
  revision: number;
  status: 'off' | 'starting' | 'listening' | 'stopping' | 'error';
  activity: 'quiet' | 'active';
  canStart: boolean;
  message: string | null;
}

export function microphoneLabel(state: MicrophoneSnapshot | null) {
  if (!desktop) return 'Available in the macOS app';
  if (!state) return 'Checking microphone status…';
  switch (state.status) {
    case 'off':
      return 'Off';
    case 'starting':
      return 'Starting…';
    case 'listening':
      return 'On';
    case 'stopping':
      return 'Stopping…';
    case 'error':
      return state.canStart ? 'Unavailable' : 'Releasing…';
  }
}

export function useMicrophone() {
  const [state, setState] = useState<MicrophoneSnapshot | null>(null);
  const [error, setError] = useState('');
  const [pendingCommand, setPendingCommand] = useState<
    'start_microphone' | 'stop_microphone' | null
  >(null);
  const pending = useRef(false);
  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let stop: (() => void) | undefined;
    const receive = (incoming: MicrophoneSnapshot) => {
      if (!disposed)
        setState((previous) =>
          !previous || incoming.revision >= previous.revision
            ? incoming
            : previous,
        );
    };
    void (async () => {
      try {
        const unsubscribe = await listen<MicrophoneSnapshot>(
          'microphone:changed',
          ({ payload }) => receive(payload),
        );
        if (disposed) {
          unsubscribe();
          return;
        }
        stop = unsubscribe;
        receive(await invoke<MicrophoneSnapshot>('microphone_snapshot'));
      } catch {
        if (!disposed)
          setError(
            'Microphone status is unavailable. Stop the microphone or restart TalkQTE.',
          );
      }
    })();
    return () => {
      disposed = true;
      stop?.();
    };
  }, []);

  async function run(command: 'start_microphone' | 'stop_microphone') {
    if (!desktop || pending.current) return;
    pending.current = true;
    setPendingCommand(command);
    setError('');
    try {
      // Command acceptance does not mean capture started or teardown finished.
      // Only ordered native snapshots change the displayed microphone state.
      await invoke<void>(command);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      pending.current = false;
      setPendingCommand(null);
    }
  }
  return {
    state,
    error,
    busy: pendingCommand !== null,
    stopPending: pendingCommand === 'stop_microphone',
    active: !!state && state.status !== 'off',
    start: () => run('start_microphone'),
    stop: () => run('stop_microphone'),
  };
}

export type Microphone = ReturnType<typeof useMicrophone>;
