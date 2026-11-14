#!/usr/bin/env node
/**
 * Executable entry: `dsh-voiceover` (or `node dist/serve-entry.js`).
 *
 * Kept separate from `cli.ts` so importing the daemon in tests cannot start it
 * as a side effect — a direct-execution check on `import.meta.url` is easy to
 * get wrong across launchers and symlinks.
 */
import { main } from "./cli.js";
void main();
//# sourceMappingURL=serve-entry.js.map