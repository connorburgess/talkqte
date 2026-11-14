import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from './types';

/** Speech may trail the session clock by this much before it is moved. */
const DRIFT_S = 0.75;

/**
 * Decodes the bundled fictional speech once and keeps it in memory. The clip
 * ships inside a lazily loaded script chunk, so playing or seeking it never
 * goes back to the app's file protocol, which buffers seeks poorly in the
 * desktop app. Never captures audio.
 */
async function decodeVoices(context: AudioContext) {
  const { default: url } = await import('../demo/welcome.mp3?inline');
  const base64 = url.slice(url.indexOf(',') + 1);
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return context.decodeAudioData(bytes.buffer);
}

type Playing = {
  source: AudioBufferSourceNode;
  startedAt: number;
  offset: number;
};

/** Local prerecorded speech follows the authoritative demo clock. */
export function useDemoVoices(state: Snapshot | null) {
  const [muted, setMuted] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [ready, setReady] = useState(false);
  const context = useRef<AudioContext | null>(null);
  const buffer = useRef<AudioBuffer | null>(null);
  const playing = useRef<Playing | null>(null);
  const failed = useRef(false);
  // Whether someone has asked for the demo, so a late failure is reported.
  const requested = useRef(false);

  const stop = () => {
    const current = playing.current;
    playing.current = null;
    if (!current) return;
    current.source.onended = null;
    try {
      current.source.stop();
    } catch {
      // Already stopped.
    }
  };
  const fail = () => {
    failed.current = true;
    stop();
    setUnavailable(true);
  };

  useEffect(() => {
    let cancelled = false;
    let created: AudioContext;
    try {
      created = new AudioContext();
    } catch {
      failed.current = true;
      return;
    }
    context.current = created;
    decodeVoices(created).then(
      (decoded) => {
        if (cancelled) return;
        buffer.current = decoded;
        setReady(true);
      },
      () => {
        if (cancelled) return;
        failed.current = true;
        if (requested.current) setUnavailable(true);
      },
    );
    return () => {
      cancelled = true;
      stop();
      context.current = null;
      void created.close().catch(() => {});
    };
  }, []);

  useEffect(() => {
    const audio = context.current;
    const decoded = buffer.current;
    const running = !!state && !state.live && state.status === 'running';
    if (!running || muted || failed.current || !audio || !decoded) {
      stop();
      return;
    }
    const position = state.elapsedMs / 1000;
    const current = playing.current;
    if (current) {
      const heard = current.offset + (audio.currentTime - current.startedAt);
      if (Math.abs(heard - position) <= DRIFT_S) return;
      stop();
    }
    if (position >= decoded.duration) return;
    const source = audio.createBufferSource();
    source.buffer = decoded;
    source.connect(audio.destination);
    source.start(0, position);
    const started = { source, startedAt: audio.currentTime, offset: position };
    source.onended = () => {
      if (playing.current === started) playing.current = null;
    };
    playing.current = started;
  }, [state, muted, ready, unavailable]);

  // Browsers allow sound to start only after a click; resuming the shared
  // context inside the click covers every later start in this session.
  const unlock = () => {
    const audio = context.current;
    if (!audio || audio.state === 'running') return;
    void audio.resume().catch(fail);
  };

  return {
    muted,
    unavailable,
    /** Call directly from the user's click. The session event starts speech. */
    start: () => {
      requested.current = true;
      if (!buffer.current) {
        if (failed.current) setUnavailable(true);
      } else {
        failed.current = false;
        setUnavailable(false);
      }
      stop();
      unlock();
    },
    pause: stop,
    toggle: () => {
      setMuted((value) => !value);
      if (muted) {
        unlock();
        if (buffer.current) {
          failed.current = false;
          setUnavailable(false);
        }
      }
    },
  };
}
