import { useState } from 'react';
import { createRoot } from 'react-dom/client';
import { SessionMode } from '../../src/components/SessionMode';
import type { SessionMode as Mode } from '../../src/lib/types';

let release: (() => void) | undefined;
export function releaseSessionMode() {
  release?.();
  release = undefined;
}

/** Fictional delayed save, with no native commands or provider requests. */
export function mountSessionMode(element: HTMLElement) {
  function Fixture() {
    const [mode, setMode] = useState<Mode>('meeting');
    return (
      <>
        <SessionMode
          mode={mode}
          locked={false}
          busy={false}
          onChange={async (next) => {
            await new Promise<void>((resolve) => {
              release = resolve;
            });
            setMode(next);
          }}
        />
        <button>Another control</button>
      </>
    );
  }
  createRoot(element).render(<Fixture />);
}
