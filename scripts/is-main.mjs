// Whether a module is the script Node was started with, as opposed to being
// imported. Node loads the script from its real location but leaves the path
// it was given in process.argv[1], so comparing the two as text fails when
// the script is reached through a linked folder (for example /tmp on macOS,
// or a linked checkout). The script would then do nothing and exit 0, which
// for a check is a silent pass. Compare the real paths instead.
import { realpathSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

export function isMain(moduleUrl, invoked = process.argv[1]) {
  if (!invoked) return false;
  try {
    return realpathSync(invoked) === realpathSync(fileURLToPath(moduleUrl));
  } catch {
    return false;
  }
}
