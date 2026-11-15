// The checkout root is anchored to this module, never to the caller's working
// directory, so lab runtime files cannot be placed inside the checkout by
// starting a process from elsewhere.
import { realpathSync } from 'node:fs';
import { isAbsolute, relative, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

export const LAB_CHECKOUT = realpathSync(
  fileURLToPath(new URL('../', import.meta.url)),
);

// True only when the canonical path is outside the checkout. A sibling named
// like `..cache` inside the checkout is not outside it.
export function outsideCheckout(path) {
  const relation = relative(LAB_CHECKOUT, realpathSync(path));
  return (
    relation === '..' || relation.startsWith('..' + sep) || isAbsolute(relation)
  );
}
