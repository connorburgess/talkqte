import { useEffect, useRef, useState } from 'react';
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';
import { desktop } from './bridge';

export type DictationTarget = 'notes' | 'focus';

export type DictationStatus =
  'off' | 'starting' | 'listening' | 'stopping' | 'error';

export interface DictationSnapshot {
  revision: number;
  status: DictationStatus;
  target: DictationTarget | null;
  canStart: boolean;
  message: string | null;
}

export interface DictationTextEvent {
  target: DictationTarget;
  seq: number;
  text: string;
}

/** Appends finalized dictated text without clobbering existing content. */
export function appendDictatedText(
  current: string,
  incoming: string,
  maxChars?: number,
): string {
  const trimmed = incoming.trim();
  if (!trimmed) return current;
  const joined =
    current.length === 0
      ? trimmed
      : /\s$/.test(current)
        ? `${current}${trimmed}`
        : `${current} ${trimmed}`;
  if (maxChars === undefined) return joined;
  const chars = [...joined];
  return chars.length <= maxChars ? joined : chars.slice(0, maxChars).join('');
}

export function dictationStatusLabel(state: DictationSnapshot | null): string {
  if (!state) return '';
  switch (state.status) {
    case 'starting':
      return state.message || 'Checking microphone access…';
    case 'listening':
      return 'Listening… Speak to dictate.';
    case 'stopping':
      return state.message || 'Finishing dictation…';
    case 'error':
      return state.message || 'Dictation stopped.';
    case 'off':
      return state.message || '';
  }
}

export function useDictation(onText: (event: DictationTextEvent) => void) {
  const [state, setState] = useState<DictationSnapshot | null>(null);
  const [error, setError] = useState('');
  const [pending, setPending] = useState(false);
  const onTextRef = useRef(onText);
  onTextRef.current = onText;
  const seenSeq = useRef<{ target: DictationTarget | null; seq: number }>({
    target: null,
    seq: 0,
  });

  useEffect(() => {
    if (!desktop) return;
    let disposed = false;
    let stopChanged: (() => void) | undefined;
    let stopText: (() => void) | undefined;

    const receiveSnapshot = (incoming: DictationSnapshot) => {
      if (disposed) return;
      if (incoming.status === 'starting') {
        seenSeq.current = { target: incoming.target, seq: 0 };
      }
      setState((previous) =>
        !previous || incoming.revision >= previous.revision
          ? incoming
          : previous,
      );
    };

    void (async () => {
      try {
        const [unlistenChanged, unlistenText] = await Promise.all([
          listen<DictationSnapshot>('dictation:changed', ({ payload }) =>
            receiveSnapshot(payload),
          ),
          listen<DictationTextEvent>('dictation:text', ({ payload }) => {
            if (disposed) return;
            if (
              seenSeq.current.target === payload.target &&
              payload.seq <= seenSeq.current.seq
            ) {
              return;
            }
            seenSeq.current = { target: payload.target, seq: payload.seq };
            onTextRef.current(payload);
          }),
        ]);
        if (disposed) {
          unlistenChanged();
          unlistenText();
          return;
        }
        stopChanged = unlistenChanged;
        stopText = unlistenText;
        receiveSnapshot(
          await invoke<DictationSnapshot>('note_dictation_snapshot'),
        );
      } catch {
        // Commands may be absent in partial test fixtures.
      }
    })();

    return () => {
      disposed = true;
      stopChanged?.();
      stopText?.();
    };
  }, []);

  async function start(target: DictationTarget) {
    if (!desktop || pending) return;
    setPending(true);
    setError('');
    try {
      await invoke<void>('start_note_dictation', { target });
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }

  async function stop() {
    if (!desktop || pending) return;
    setPending(true);
    setError('');
    try {
      await invoke<void>('stop_note_dictation');
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setPending(false);
    }
  }

  function stopQuietly() {
    if (!desktop) return;
    void invoke<void>('stop_note_dictation').catch(() => {});
  }

  const active =
    !!state &&
    (state.status === 'starting' ||
      state.status === 'listening' ||
      state.status === 'stopping');

  return {
    state,
    error,
    busy: pending,
    active,
    start,
    stop,
    stopQuietly,
    clearError: () => setError(''),
  };
}
