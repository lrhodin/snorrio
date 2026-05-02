// Atomic file write: write to "<path>.tmp", then rename onto <path>.
// On rename failure, the .tmp file is removed so the directory is not
// littered with stale temp files. The destination is left untouched —
// readers see either the previous content or the new content, never
// a partial write and never an absent file.
//
// Extracted from episode-daemon.ts so the invariant is testable in
// isolation. Behaviour is unchanged from the original inline helper
// except for the failure-path cleanup (which was previously absent).

import {
  writeFileSync as _writeFileSync,
  renameSync as _renameSync,
  unlinkSync as _unlinkSync,
  mkdirSync as _mkdirSync,
} from "fs";
import { dirname } from "path";

// Indirection object so tests can inject failures without forking the
// implementation. Production code never mutates this.
export const _io = {
  writeFileSync: _writeFileSync,
  renameSync: _renameSync,
  unlinkSync: _unlinkSync,
  mkdirSync: _mkdirSync,
};

export function atomicWriteFile(filePath: string, content: string): void {
  _io.mkdirSync(dirname(filePath), { recursive: true });
  const tmp = filePath + ".tmp";
  _io.writeFileSync(tmp, content, "utf8");
  try {
    _io.renameSync(tmp, filePath);
  } catch (err) {
    try { _io.unlinkSync(tmp); } catch { /* best-effort */ }
    throw err;
  }
}
