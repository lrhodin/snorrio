// One scan of the episodes tree, keyed by session id.
//
// Why this exists: an episode's location was found by RECOMPUTING its date from
// the session's timestamp — `join(episodesDir, dateOf(s), `${s.id}.md`)` in
// findStaleSessions(). That made the lookup a function of the current system
// timezone, and the file on disk a function of the timezone in effect when it
// was written. Changing the box zone would therefore make existing episodes
// invisible: they would be regenerated into a different day directory while the
// originals stayed behind, orphaned, and the day/week/month/quarter/year caches
// would then count the same session twice. Measured against the live 624-file
// store, the recomputed date disagrees with the directory the episode already
// sits in for 246 files under America/Los_Angeles, 112 under Europe/Stockholm and
// 292 under Asia/Kolkata.
//
// A session id, by contrast, does not move. Indexing by it makes episode lookup
// independent of the date function entirely, which is the property that turns a
// timezone change into a no-op.
//
// The scan itself is not new — buildCacheProvenanceManifest() already walked
// episodes/*/*.md reading session_id from frontmatter. That walk lives here now
// and both callers share it, so there is exactly one definition of "where do
// episodes live and which session does each belong to".

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEpisodeFrontmatter } from "./episode-frontmatter.ts";

export interface EpisodeRecord {
  /** Session the episode was written for (frontmatter `session_id`, else the filename). */
  sessionId: string;
  /** Absolute path of the episode file. */
  path: string;
  /** Parent directory name, YYYY-MM-DD. The bucketing key as it stands on disk. */
  date: string;
  /** File name without ".md". */
  fileId: string;
  /** Raw file contents, read once during the scan. */
  content: string;
}

export interface EpisodeIndex {
  /** Every episode found, ordered by date then filename. */
  episodes: EpisodeRecord[];
  /** Episode dates that contain at least one .md, sorted. */
  dates: string[];
  /**
   * Every episode recorded for a session id, in scan order.
   *
   * A list rather than a single record because the store genuinely holds the
   * same session under more than one date: 32 session ids appear in two or three
   * day directories (624 files, 591 distinct ids), from sessions that spanned
   * midnight and were regenerated on a later day. Collapsing them silently would
   * hide exactly the duplication this index exists to make visible.
   */
  bySession: Map<string, EpisodeRecord[]>;
}

/**
 * Walk `episodesDir` once.
 *
 * Unreadable files and unreadable directories are skipped rather than thrown on:
 * this runs inside the daemon's reconciliation loop, where one bad file must not
 * stop the sweep.
 */
export function buildEpisodeIndex(episodesDir: string): EpisodeIndex {
  const episodes: EpisodeRecord[] = [];
  const dates: string[] = [];
  const bySession = new Map<string, EpisodeRecord[]>();

  let dayDirs: string[] = [];
  try {
    dayDirs = readdirSync(episodesDir).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort();
  } catch { return { episodes, dates, bySession }; }

  for (const date of dayDirs) {
    const dir = join(episodesDir, date);
    let files: string[] = [];
    try { files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort(); } catch { continue; }
    if (!files.length) continue;
    dates.push(date);
    for (const file of files) {
      const path = join(dir, file);
      let content: string;
      try { content = readFileSync(path, "utf8"); } catch { continue; }
      const fileId = file.slice(0, -3);
      const parsed = parseEpisodeFrontmatter(content);
      const raw = parsed.fields.get("session_id");
      const sessionId = frontmatterString(raw) ?? fileId;
      const record: EpisodeRecord = { sessionId, path, date, fileId, content };
      episodes.push(record);
      const existing = bySession.get(sessionId);
      if (existing) existing.push(record);
      else bySession.set(sessionId, [record]);
    }
  }

  return { episodes, dates, bySession };
}

function frontmatterString(raw: string | undefined): string | null {
  if (raw === undefined || raw === "null") return null;
  if (raw.startsWith('"')) { try { return JSON.parse(raw); } catch { return null; } }
  return raw || null;
}
