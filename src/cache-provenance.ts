import { readFileSync, readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.ts";
import { dateToWeek, monthToQuarter } from "./cascade-decision.ts";
import { parseEpisodeFrontmatter } from "./episode-frontmatter.ts";
import { buildEpisodeIndex, type EpisodeIndex } from "./episode-index.ts";
import { getSessionLineageIndex, type SessionLineageIndex } from "./session-lineage.ts";
import { SNORRIO_HOME } from "./ai.ts";
import { normalizeTemporalNarrative, temporalNarrativeViolation } from "./temporal-narrative.ts";
import { periodState } from "./period-state.ts";

export const CACHE_PROVENANCE_SCHEMA_VERSION = 1;
export type CacheLevel = "day" | "week" | "month" | "quarter" | "year";

export interface CacheProvenanceFamily {
  provenanceFamilyId: string;
  sessionIds: string[];
  lineageComplete: boolean;
  lineageConflict: boolean;
}

export interface CacheProvenanceManifest {
  schemaVersion: 1;
  level: CacheLevel;
  ref: string;
  coveredRefs: string[];
  families: CacheProvenanceFamily[];
  /**
   * Whether the period was open or closed when its summary was WRITTEN. Absent
   * on legacy sidecars. Not part of the evidence comparison (sameManifest): it
   * describes the prose, not the inputs, so it must never mark a cache stale
   * on its own — only the closing-rebuild check reads it.
   */
  periodState?: "open" | "closed";
}

const LEVEL_DIRS: Record<CacheLevel, string> = {
  day: "days", week: "weeks", month: "months", quarter: "quarters", year: "years",
};

function scalar(raw: string | undefined): string | null {
  if (raw === undefined || raw === "null") return null;
  if (raw.startsWith('"')) { try { return JSON.parse(raw); } catch { return null; } }
  return raw;
}

function boolean(raw: string | undefined): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

export function cacheManifestPath(level: CacheLevel, ref: string, cacheDir = join(SNORRIO_HOME, "cache")): string {
  return join(cacheDir, LEVEL_DIRS[level], `${ref}.provenance.json`);
}

function dateMatches(level: CacheLevel, ref: string, date: string): boolean {
  if (level === "day") return date === ref;
  if (level === "week") return dateToWeek(date) === ref;
  if (level === "month") return date.startsWith(`${ref}-`);
  if (level === "quarter") return monthToQuarter(date.slice(0, 7)) === ref;
  return date.startsWith(`${ref}-`);
}

function coveredRefs(level: CacheLevel, dates: string[], sessions: string[]): string[] {
  if (level === "day") return sessions.map((id) => `session:${id}`).sort();
  if (level === "week") return [...new Set(dates)].sort();
  if (level === "month") return [...new Set(dates.map(dateToWeek))].sort();
  if (level === "quarter") return [...new Set(dates.map((date) => date.slice(0, 7)))].sort();
  return [...new Set(dates.map((date) => monthToQuarter(date.slice(0, 7))))].sort();
}

export function buildCacheProvenanceManifest(
  level: CacheLevel,
  ref: string,
  options: { episodesDir?: string; lineageIndex?: SessionLineageIndex; episodeIndex?: EpisodeIndex } = {},
): CacheProvenanceManifest {
  const episodesDir = options.episodesDir ?? join(SNORRIO_HOME, "episodes");
  const lineageIndex = options.lineageIndex ?? getSessionLineageIndex();
  // One shared walk of the episodes tree (src/episode-index.ts), so this and
  // findStaleSessions() agree on where episodes are and which session owns each.
  const episodeIndex = options.episodeIndex ?? buildEpisodeIndex(episodesDir);
  const familyMap = new Map<string, CacheProvenanceFamily>();
  const coveredSessions: string[] = [];
  const matchingDates = episodeIndex.dates.filter((date) => dateMatches(level, ref, date));
  const matching = new Set(matchingDates);

  // episodeIndex.episodes is already ordered by date then filename, which is the
  // order the previous nested readdir walk produced.
  for (const record of episodeIndex.episodes) {
    if (!matching.has(record.date)) continue;
    const { content, sessionId } = record;
    const parsed = parseEpisodeFrontmatter(content);
    const indexed = lineageIndex.getById(sessionId);
    // The structural index is live and can learn a dependency after an
    // episode was written (for example when a parent appends subagent_result).
    // Prefer it when available; persisted episode metadata is the durable
    // fallback when the original session tree is no longer present.
    const familyId = indexed?.provenanceFamilyId
      ?? scalar(parsed.fields.get("provenance_family_id"))
      ?? sessionId;
    const metadataCurrent = parsed.fields.get("lineage_metadata_version") === "1";
    const explicitComplete = boolean(parsed.fields.get("lineage_complete"));
    const explicitConflict = boolean(parsed.fields.get("lineage_conflict"));
    const hasStructuralEdge = indexed && indexed.lineageSource !== "none" && indexed.lineageSource !== "unknown";
    // A legacy standalone session is deliberately unknown/incomplete: the
    // live index cannot prove that an old delegated edge never existed. A
    // current metadata record or newly discovered edge is stronger.
    const complete = hasStructuralEdge ? indexed.lineageComplete : metadataCurrent ? explicitComplete ?? false : false;
    const conflict = hasStructuralEdge ? indexed.lineageConflict : explicitConflict ?? indexed?.lineageConflict ?? false;
    coveredSessions.push(sessionId);
    const family = familyMap.get(familyId) ?? {
      provenanceFamilyId: familyId,
      sessionIds: [],
      lineageComplete: true,
      lineageConflict: false,
    };
    family.sessionIds.push(sessionId);
    family.lineageComplete &&= complete;
    family.lineageConflict ||= conflict;
    familyMap.set(familyId, family);
  }

  const families = [...familyMap.values()].map((family) => ({
    ...family,
    sessionIds: [...new Set(family.sessionIds)].sort(),
  })).sort((a, b) => a.provenanceFamilyId.localeCompare(b.provenanceFamilyId));

  return {
    schemaVersion: CACHE_PROVENANCE_SCHEMA_VERSION,
    level,
    ref,
    coveredRefs: coveredRefs(level, matchingDates, coveredSessions),
    families,
  };
}

export function writeCacheWithProvenance(
  level: CacheLevel,
  ref: string,
  summary: string,
  options: { cacheDir?: string; episodesDir?: string; lineageIndex?: SessionLineageIndex; episodeIndex?: EpisodeIndex; today?: string } = {},
): CacheProvenanceManifest {
  const state = periodState(level, ref, options.today);
  if (state === "future") throw new Error(`refusing to publish ${level} ${ref}: the period has not started`);
  const normalized = normalizeTemporalNarrative(level, ref, summary);
  const violation = temporalNarrativeViolation(normalized);
  if (violation) throw new Error(`refusing to publish ${level} ${ref}: ${violation}`);
  const cacheDir = options.cacheDir ?? join(SNORRIO_HOME, "cache");
  atomicWriteFile(join(cacheDir, LEVEL_DIRS[level], `${ref}.md`), normalized);
  const manifest = { ...buildCacheProvenanceManifest(level, ref, options), periodState: state };
  writeCacheProvenanceManifest(manifest, cacheDir);
  return manifest;
}

export function writeCacheProvenanceManifest(
  manifest: CacheProvenanceManifest,
  cacheDir = join(SNORRIO_HOME, "cache"),
): void {
  // Evidence-only rewrites (migrations, ensureCacheProvenanceManifest) don't
  // change the prose, so they keep the state the prose was written under.
  if (!manifest.periodState) {
    const recorded = readCacheProvenanceManifest(manifest.level, manifest.ref, cacheDir)?.periodState;
    if (recorded) manifest = { ...manifest, periodState: recorded };
  }
  atomicWriteFile(cacheManifestPath(manifest.level, manifest.ref, cacheDir), JSON.stringify(manifest, null, 2) + "\n");
}

export function readCacheProvenanceManifest(
  level: CacheLevel,
  ref: string,
  cacheDir = join(SNORRIO_HOME, "cache"),
): CacheProvenanceManifest | null {
  try {
    const parsed = JSON.parse(readFileSync(cacheManifestPath(level, ref, cacheDir), "utf8"));
    if (
      parsed?.schemaVersion !== CACHE_PROVENANCE_SCHEMA_VERSION ||
      parsed?.level !== level || parsed?.ref !== ref ||
      !Array.isArray(parsed?.coveredRefs) || !parsed.coveredRefs.every((value: unknown) => typeof value === "string") ||
      !Array.isArray(parsed?.families) || !parsed.families.every((family: any) =>
        typeof family?.provenanceFamilyId === "string" &&
        Array.isArray(family?.sessionIds) && family.sessionIds.every((value: unknown) => typeof value === "string") &&
        typeof family?.lineageComplete === "boolean" && typeof family?.lineageConflict === "boolean"
      )
    ) return null;
    return parsed;
  } catch { return null; }
}

function evidenceOnly(manifest: CacheProvenanceManifest): CacheProvenanceManifest {
  const { periodState: _state, ...evidence } = manifest;
  return evidence;
}

function sameManifest(a: CacheProvenanceManifest, b: CacheProvenanceManifest): boolean {
  return JSON.stringify(evidenceOnly(a)) === JSON.stringify(evidenceOnly(b));
}

/**
 * A closed period whose summary was written while it was still open (or before
 * period state was recorded) needs one rebuild so it reads as finished. Days
 * are exempt: a day written during the day is already an account of that day,
 * and a nightly closing rebuild would re-run the whole cascade every midnight.
 */
export function cacheNeedsClosingRebuild(
  level: CacheLevel,
  ref: string,
  options: { cacheDir?: string; today?: string } = {},
): boolean {
  if (level === "day") return false;
  if (periodState(level, ref, options.today) !== "closed") return false;
  const cacheDir = options.cacheDir ?? join(SNORRIO_HOME, "cache");
  return readCacheProvenanceManifest(level, ref, cacheDir)?.periodState !== "closed";
}

export function ensureCacheProvenanceManifest(
  level: CacheLevel,
  ref: string,
  options: { cacheDir?: string; episodesDir?: string; lineageIndex?: SessionLineageIndex; episodeIndex?: EpisodeIndex; force?: boolean } = {},
): CacheProvenanceManifest {
  const cacheDir = options.cacheDir ?? join(SNORRIO_HOME, "cache");
  const expected = buildCacheProvenanceManifest(level, ref, options);
  if (!options.force) {
    const existing = readCacheProvenanceManifest(level, ref, cacheDir);
    if (existing && sameManifest(existing, expected)) return existing;
  }
  writeCacheProvenanceManifest(expected, cacheDir);
  return expected;
}

export function cacheManifestNeedsRefresh(
  level: CacheLevel,
  ref: string,
  newestInputMtime: number,
  options: { cacheDir?: string; episodesDir?: string; lineageIndex?: SessionLineageIndex; episodeIndex?: EpisodeIndex } = {},
): boolean {
  const cacheDir = options.cacheDir ?? join(SNORRIO_HOME, "cache");
  const path = cacheManifestPath(level, ref, cacheDir);
  const existing = readCacheProvenanceManifest(level, ref, cacheDir);
  if (!existing) return true;
  try { if (statSync(path).mtimeMs < newestInputMtime) return true; }
  catch { return true; }
  const expected = buildCacheProvenanceManifest(level, ref, options);
  return !sameManifest(existing, expected);
}

export function formatManifestForPrompt(manifest: CacheProvenanceManifest): string {
  return JSON.stringify(manifest);
}
