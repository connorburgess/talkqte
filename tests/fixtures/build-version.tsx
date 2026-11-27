import { createRoot } from 'react-dom/client';
import { BuildVersion } from '../../src/components/BuildVersion';
import type { BuildInfo } from '../../src/lib/build-info';

/** Browser-only fictional component fixture; no native bridge is called. */
export function mountBuildVersion(
  element: HTMLElement,
  value: BuildInfo | null,
  reject: boolean,
) {
  createRoot(element).render(
    <BuildVersion
      read={() =>
        reject
          ? Promise.reject(new Error('fictional refusal'))
          : Promise.resolve(value)
      }
    />,
  );
}
