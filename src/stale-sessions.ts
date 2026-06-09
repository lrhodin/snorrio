// Which sessions need (re)generation? A session needs an episode when no
// episode file exists for it, or when the session file is newer than its
// episode (the session kept growing after the episode was written).
//
// Extracted from sweep() so flush can reconcile against DISK, not just the
// in-memory debounce timers. Fresh-machine bug (found in the 2026-06-09 VM
// onboarding test): the daemon started before ~/.pi/agent/sessions existed,
// the watcher was never installed, timers stayed empty, and `snorrio flush`
// reported "All sessions up to date" while unprocessed sessions sat on disk.
// Trusting the filesystem makes that claim true by construction.

import { existsSync, statSync } from "fs";
import { join } from "path";

export interface StaleCheckSession {
  id: string;
  path: string;
}

export interface StaleScanResult<S> {
  /** Sessions that need an episode (missing or outdated). */
  stale: S[];
  /** Count of sessions whose episodes are up to date. */
  fresh: number;
}

export function findStaleSessions<S extends StaleCheckSession>(
  sessions: S[],
  episodesDir: string,
  dateOf: (s: S) => string,
  log?: (msg: string) => void,
): StaleScanResult<S> {
  const stale: S[] = [];
  let fresh = 0;
  for (const s of sessions) {
    const epPath = join(episodesDir, dateOf(s), `${s.id}.md`);
    if (existsSync(epPath)) {
      const sessionMtime = statSync(s.path).mtimeMs;
      const episodeMtime = statSync(epPath).mtimeMs;
      if (sessionMtime <= episodeMtime) {
        fresh++;
        continue;
      }
      log?.(`  Stale episode: ${s.id.slice(0, 8)} (session newer by ${Math.round((sessionMtime - episodeMtime) / 1000)}s)`);
    }
    stale.push(s);
  }
  return { stale, fresh };
}
