import { useEffect, useRef, useState } from 'react';
import { desktop } from './bridge';
import { processingApi, type ProcessingSnapshot } from './processing';

/** Notebook capture controls bypass the ordered notes command queue. */
export function useCaptureControl() {
  const [state, setState] = useState<ProcessingSnapshot | null>(null);
  const [statusError, setStatusError] = useState(false);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [attempt, setAttempt] = useState(0);
  const mounted = useRef(false);
  const stopping = useRef(false);
  const receive = (incoming: ProcessingSnapshot) => {
    if (!mounted.current) return;
    setState((previous) =>
      !previous || incoming.revision >= previous.revision ? incoming : previous,
    );
    setStatusError(false);
  };
  useEffect(() => {
    if (!desktop) return;
    mounted.current = true;
    let disposed = false;
    let unlisten: (() => void) | undefined;
    // Listen first, then reject any initial snapshot older than an event.
    void (async () => {
      try {
        const stop = await processingApi.listen((incoming) => {
          if (!disposed) receive(incoming);
        });
        if (disposed) return stop();
        unlisten = stop;
        const initial = await processingApi.snapshot();
        if (!disposed) receive(initial);
      } catch {
        if (!disposed) setStatusError(true);
      }
    })();
    return () => {
      disposed = true;
      mounted.current = false;
      unlisten?.();
    };
  }, [attempt]);

  async function refresh() {
    try {
      const next = await processingApi.snapshot();
      receive(next);
      return next;
    } catch (error) {
      if (mounted.current) setStatusError(true);
      throw error;
    }
  }

  async function stop() {
    // Use the displayed target, never a refreshed replacement operation. A
    // rejected stale action refreshes status, but requires another user click.
    if (!state || stopping.current) return;
    stopping.current = true;
    setBusy(true);
    setError('');
    try {
      await processingApi.stop(state.stopTarget);
    } catch {
      if (mounted.current)
        setError(
          'Could not stop this session. Check its status and try again.',
        );
    } finally {
      try {
        await refresh();
      } catch {
        if (mounted.current) setStatusError(true);
      }
      stopping.current = false;
      if (mounted.current) setBusy(false);
    }
  }
  return {
    state,
    statusError,
    error,
    busy,
    stop,
    refresh,
    clearError: () => setError(''),
    retryStatus: () => setAttempt((value) => value + 1),
  };
}
