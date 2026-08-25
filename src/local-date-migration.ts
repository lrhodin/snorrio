// Backfill the local_date block onto episodes written before it existed.
//
// The bucketing key becomes explicit rather than derived. Each episode is
// stamped with the directory it ALREADY sits in, which freezes history exactly
// as it stands: no file moves, no regeneration, no prose touched. Re-deriving
// the date from the timestamp instead would move episodes the moment the
// machine's zone changed — against the live store the recomputed date disagrees
// with the existing directory for 246 files under America/Los_Angeles, 112 under
// Europe/Stockholm and 292 under Asia/Kolkata.
//
// tz is recorded as "Etc/UTC" with tz_source "assumed", not "system": every
// episode to date was written while the box was Etc/UTC, but that is a claim
// reconstructed after the fact from the era rather than something observed per
// episode, and "assumed" is the honest label for it. The era is deliberately not
// split at the 2026-07-30 vdesk build.
//
// Same shape as src/provenance-migration.ts: metadata-only, dry-runnable,
// idempotent by replacing the four keys rather than appending them.

import { atomicWriteFile } from "./atomic-write.ts";
import { buildEpisodeIndex, type EpisodeIndex } from "./episode-index.ts";
import {
  parseEpisodeFrontmatter,
  upsertEpisodeLocalDate,
  type EpisodeLocalDate,
  type TimezoneSource,
} from "./episode-frontmatter.ts";

/** The zone the store was recorded under, before local_date was written at generation time. */
export const HISTORICAL_TZ = "Etc/UTC";
export const HISTORICAL_UTC_OFFSET = "+00:00";
export const HISTORICAL_TZ_SOURCE: TimezoneSource = "assumed";

export interface LocalDateMigrationResult {
  episodesScanned: number;
  /** Episodes whose bytes would change (or did). */
  episodesChanged: number;
  /** Episodes already carrying the exact expected block. */
  episodesAlreadyStamped: number;
  /** Episodes that could not be stamped, with the reason. Never silently dropped. */
  skipped: Array<{ path: string; reason: string }>;
}

export function migrateEpisodeLocalDates(options: {
  episodesDir: string;
  dryRun?: boolean;
  episodeIndex?: EpisodeIndex;
  tz?: string;
  utcOffset?: string;
  tzSource?: TimezoneSource;
}): LocalDateMigrationResult {
  const dryRun = options.dryRun ?? false;
  const index = options.episodeIndex ?? buildEpisodeIndex(options.episodesDir);
  const tz = options.tz ?? HISTORICAL_TZ;
  const utcOffset = options.utcOffset ?? HISTORICAL_UTC_OFFSET;
  const tzSource = options.tzSource ?? HISTORICAL_TZ_SOURCE;

  const result: LocalDateMigrationResult = {
    episodesScanned: 0,
    episodesChanged: 0,
    episodesAlreadyStamped: 0,
    skipped: [],
  };

  for (const record of index.episodes) {
    result.episodesScanned++;
    // The directory name IS the local date. Not the timestamp, not `new Date()`.
    const localDate: EpisodeLocalDate = { localDate: record.date, tz, utcOffset, tzSource };

    let updated: string;
    try {
      updated = upsertEpisodeLocalDate(record.content, localDate);
    } catch (err: any) {
      result.skipped.push({ path: record.path, reason: err?.message ?? "unknown error" });
      continue;
    }

    if (updated === record.content) { result.episodesAlreadyStamped++; continue; }
    result.episodesChanged++;
    if (!dryRun) atomicWriteFile(record.path, updated);
  }

  return result;
}

export interface LocalDateAudit {
  episodes: number;
  /** Episodes carrying all four keys. */
  stamped: number;
  /** Episodes whose local_date does not equal their parent directory. */
  mismatched: Array<{ path: string; localDate: string | null; dir: string }>;
}

/**
 * Verify the invariant the migration exists to establish: every episode carries
 * the four keys, and local_date equals the directory it sits in.
 */
export function auditEpisodeLocalDates(options: {
  episodesDir: string;
  episodeIndex?: EpisodeIndex;
}): LocalDateAudit {
  const index = options.episodeIndex ?? buildEpisodeIndex(options.episodesDir);
  const audit: LocalDateAudit = { episodes: 0, stamped: 0, mismatched: [] };
  for (const record of index.episodes) {
    audit.episodes++;
    const fields = parseEpisodeFrontmatter(record.content).fields;
    const localDate = unquote(fields.get("local_date"));
    const hasAll = localDate !== null
      && unquote(fields.get("tz")) !== null
      && unquote(fields.get("utc_offset")) !== null
      && unquote(fields.get("tz_source")) !== null;
    if (hasAll) audit.stamped++;
    if (localDate !== record.date) {
      audit.mismatched.push({ path: record.path, localDate, dir: record.date });
    }
  }
  return audit;
}

function unquote(raw: string | undefined): string | null {
  if (raw === undefined || raw === "null" || raw === "") return null;
  if (raw.startsWith('"')) { try { return JSON.parse(raw); } catch { return null; } }
  return raw;
}
