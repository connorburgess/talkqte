import { useEffect, useRef, useState } from 'react';
import type { Snapshot } from './types';

/** Local prerecorded speech follows the authoritative demo clock. Never capture. */
export function useDemoVoices(state: Snapshot | null) {
  const audio = useRef<HTMLAudioElement>(null);
  const latest = useRef(state);
  latest.current = state;
  const [muted, setMuted] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const failed = useRef(false);
  const pending = useRef(false);
  const mounted = useRef(true);
  const running = () => {
    const current = latest.current;
    return current && !current.live && current.status === 'running';
  };
  const fail = () => {
    failed.current = true;
    audio.current?.pause();
    if (mounted.current) setUnavailable(true);
  };
  const play = () => {
    const player = audio.current;
    if (!player || pending.current || failed.current) return;
    pending.current = true;
    void player.play().then(
      () => {
        pending.current = false;
        // A late successful play must not restart sound after Pause/End/unmount.
        if (!mounted.current || !running()) player.pause();
      },
      () => {
        pending.current = false;
        if (mounted.current && running()) fail();
      },
    );
  };
  useEffect(() => {
    mounted.current = true;
    return () => {
      mounted.current = false;
      audio.current?.pause();
    };
  }, []);
  useEffect(() => {
    const player = audio.current;
    if (!player || !state) return;
    player.muted = muted;
    if (!running()) player.pause();
    // Seek only once the local media duration is known. Small clock jitter must
    // not continually restart words; pause/replay still align on their event.
    const position = state.live ? 0 : state.elapsedMs / 1000;
    if (player.readyState > 0 && Math.abs(player.currentTime - position) > 0.4)
      player.currentTime = Math.min(position, player.duration);
    if (running() && !muted && !failed.current && player.paused) play();
    if (muted) player.pause();
  }, [state, muted]);
  return {
    audio,
    muted,
    unavailable,
    fail,
    // Call directly from the user's click to allow playback in WebKit. The
    // session event remains the authority for elapsed time and continuation.
    start: () => {
      failed.current = false;
      setUnavailable(false);
      if (audio.current) audio.current.currentTime = 0;
      if (!muted) play();
    },
    pause: () => audio.current?.pause(),
    toggle: () => {
      const next = !muted;
      if (audio.current) audio.current.muted = next;
      setMuted(next);
      if (next) audio.current?.pause();
      else {
        failed.current = false;
        setUnavailable(false);
        if (running()) play();
      }
    },
  };
}
