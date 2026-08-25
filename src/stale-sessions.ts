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
//
// Lookup is by SESSION ID, not by a recomputed date. It used to build the
// episode path as join(episodesDir, dateOf(session), `${id}.md`), which made
// "does an episode exist" a question about the current system timezone. Under a
// different zone the recomputed date disagrees with the directory an episode
// already sits in for hundreds of files in the live store, so every one of them
// would have looked missing, been regenerated into a new day directory, and left
// its original behind to be counted a second time by the day/week/month caches.
// An id does not move when the clock does. See src/episode-index.ts.

import { statSync } from "fs";
import { buildEpisodeIndex, type EpisodeIndex } from "./episode-index.ts";

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

export interface StaleScanOptions {
  log?: (msg: string) => void;
  /** Reuse an index already built by the caller instead of walking the tree again. */
  index?: EpisodeIndex;
}

export function findStaleSessions<S extends StaleCheckSession>(
  sessions: S[],
  episodesDir: string,
  options: StaleScanOptions = {},
): StaleScanResult<S> {
  const { log } = options;
  const index = options.index ?? buildEpisodeIndex(episodesDir);
  const stale: S[] = [];
  let fresh = 0;

  for (const s of sessions) {
    const records = index.bySession.get(s.id);
    if (!records?.length) { stale.push(s); continue; }

    // A session can hold more than one episode (it spanned midnight and was
    // regenerated on a later day; 32 ids in the live store do). Compare against
    // the newest of them: if ANY recorded episode is current, the session's
    // content is already captured and regenerating would only add another copy.
    let newestEpisodeMtime = 0;
    for (const record of records) {
      try { newestEpisodeMtime = Math.max(newestEpisodeMtime, statSync(record.path).mtimeMs); } catch {}
    }
    if (!newestEpisodeMtime) { stale.push(s); continue; }

    let sessionMtime: number;
    try { sessionMtime = statSync(s.path).mtimeMs; } catch { stale.push(s); continue; }

    if (sessionMtime <= newestEpisodeMtime) { fresh++; continue; }
    log?.(`  Stale episode: ${s.id.slice(0, 8)} (session newer by ${Math.round((sessionMtime - newestEpisodeMtime) / 1000)}s)`);
    stale.push(s);
  }

  return { stale, fresh };
}
