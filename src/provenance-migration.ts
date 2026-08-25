import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { atomicWriteFile } from "./atomic-write.ts";
import { buildCacheProvenanceManifest, writeCacheProvenanceManifest, type CacheLevel } from "./cache-provenance.ts";
import { defaultMachine, parseEpisodeFrontmatter, upsertEpisodeLineageMetadata } from "./episode-frontmatter.ts";
import { HISTORICAL_TZ, HISTORICAL_TZ_SOURCE, HISTORICAL_UTC_OFFSET } from "./local-date-migration.ts";
import type { SessionLineage, SessionLineageIndex } from "./session-lineage.ts";

export interface ProvenanceMigrationResult {
  episodesScanned: number;
  episodesChanged: number;
  episodesUnknown: number;
  manifestsWritten: number;
  affectedDates: string[];
}

interface RecascadeMarker { schemaVersion: 1; signatures: Record<string, string> }

const CACHE_LEVEL_DIRS: Array<[CacheLevel, string]> = [
  ["day", "days"], ["week", "weeks"], ["month", "months"], ["quarter", "quarters"], ["year", "years"],
];

function frontmatterScalar(raw: string | undefined): string | null {
  if (raw === undefined || raw === "null") return null;
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

function unknownLineage(sessionId: string, sessionPath: string): SessionLineage {
  return {
    sessionId,
    sessionPath,
    parentSessionId: null,
    rootSessionId: sessionId,
    provenanceFamilyId: sessionId,
    lineageDepth: 0,
    lineageSource: "unknown",
    lineageComplete: false,
    lineageConflict: false,
    dependencySessionIds: [],
    issues: ["historical episode has no recoverable lineage edge"],
  };
}

export function migrationLineage(
  sessionId: string,
  index: SessionLineageIndex,
  legacyEpisode: boolean,
  historicallyUnknown = false,
): SessionLineage {
  const indexed = index.getById(sessionId);
  if (!indexed) return unknownLineage(sessionId, "unknown");
  if (
    (legacyEpisode || historicallyUnknown) && indexed.lineageSource === "none" &&
    indexed.parentSessionId === null && indexed.dependencySessionIds.length === 0
  ) return unknownLineage(sessionId, indexed.sessionPath);
  return indexed;
}

export function planProvenanceRecascade(
  result: ProvenanceMigrationResult,
  options: { cacheDir: string; episodesDir: string; lineageIndex: SessionLineageIndex },
): { dates: string[]; signatures: Record<string, string> } {
  const markerPath = join(options.cacheDir, "provenance-migration-v1.json");
  let previous: RecascadeMarker = { schemaVersion: 1, signatures: {} };
  try {
    const parsed = JSON.parse(readFileSync(markerPath, "utf8"));
    if (parsed?.schemaVersion === 1 && parsed.signatures) previous = parsed;
  } catch {}
  const signatures: Record<string, string> = {};
  const dates: string[] = [];
  // Include previously affected dates too. If a repaired structural record
  // splits a former multi-session family, the old prose still needs one final
  // rebuild; considering only today's affected set would leave it grouped
  // forever.
  const candidates = [...new Set([...Object.keys(previous.signatures), ...result.affectedDates])].sort();
  const currentlyAffected = new Set(result.affectedDates);
  for (const date of candidates) {
    const manifest = buildCacheProvenanceManifest("day", date, { episodesDir: options.episodesDir, lineageIndex: options.lineageIndex });
    const signature = JSON.stringify(manifest);
    if (previous.signatures[date] !== signature || !currentlyAffected.has(date)) dates.push(date);
    if (currentlyAffected.has(date)) signatures[date] = signature;
  }
  return { dates: [...new Set(dates)], signatures };
}

export function writeProvenanceRecascadeMarker(cacheDir: string, signatures: Record<string, string>): void {
  atomicWriteFile(join(cacheDir, "provenance-migration-v1.json"), JSON.stringify({ schemaVersion: 1, signatures }, null, 2) + "\n");
}

export function migrateProvenanceMetadata(options: {
  episodesDir: string;
  cacheDir: string;
  lineageIndex: SessionLineageIndex;
  home: string;
  machine?: string;
  dryRun?: boolean;
}): ProvenanceMigrationResult {
  const { episodesDir, cacheDir, lineageIndex, home } = options;
  const dryRun = options.dryRun ?? false;
  const familySizes = new Map<string, number>();
  for (const lineage of lineageIndex.sessions) {
    familySizes.set(lineage.provenanceFamilyId, (familySizes.get(lineage.provenanceFamilyId) ?? 0) + 1);
  }

  let episodesScanned = 0, episodesChanged = 0, episodesUnknown = 0, manifestsWritten = 0;
  const affectedDates = new Set<string>();
  let dates: string[] = [];
  try { dates = readdirSync(episodesDir).filter((date) => /^\d{4}-\d{2}-\d{2}$/.test(date)).sort(); } catch {}

  for (const date of dates) {
    const dir = join(episodesDir, date);
    let files: string[] = [];
    try { files = readdirSync(dir).filter((file) => file.endsWith(".md")).sort(); } catch {}
    for (const file of files) {
      episodesScanned++;
      const path = join(dir, file);
      const content = readFileSync(path, "utf8");
      const parsed = parseEpisodeFrontmatter(content);
      const sessionId = frontmatterScalar(parsed.fields.get("session_id")) ?? file.slice(0, -3);
      const legacyEpisode = parsed.fields.get("lineage_metadata_version") !== "1";
      const historicalSource = frontmatterScalar(parsed.fields.get("lineage_source"));
      const lineage = migrationLineage(
        sessionId,
        lineageIndex,
        legacyEpisode,
        historicalSource === "unknown" || (legacyEpisode && historicalSource === "none"),
      );
      if (lineage.lineageSource === "unknown") episodesUnknown++;
      if ((familySizes.get(lineage.provenanceFamilyId) ?? 1) > 1) affectedDates.add(date);
      const migrated = upsertEpisodeLineageMetadata(content, lineage, {
        origin: "pi",
        machine: options.machine ?? defaultMachine(),
        sourcePath: lineage.sessionPath,
        home,
        timestamp: parsed.fields.get("timestamp")?.replace(/^"|"$/g, "") ?? `${date}T00:00:00Z`,
        // Only reached for an episode with no frontmatter at all, where a whole
        // block is generated. The bucket is the directory the file already sits
        // in — never a recomputed date. An episode that already has frontmatter
        // keeps whatever local_date it carries: upsertEpisodeLineageMetadata
        // rewrites only the lineage keys.
        localDate: {
          localDate: date,
          tz: HISTORICAL_TZ,
          utcOffset: HISTORICAL_UTC_OFFSET,
          tzSource: HISTORICAL_TZ_SOURCE,
        },
      });
      if (migrated !== content) {
        episodesChanged++;
        if (!dryRun) atomicWriteFile(path, migrated);
      }
    }
  }

  // Sidecars are metadata-only and can be built without regenerating episodes or
  // asking an LLM. Existing summary prose remains untouched here.
  for (const [level, dirName] of CACHE_LEVEL_DIRS) {
    const dir = join(cacheDir, dirName);
    let refs: string[] = [];
    try { refs = readdirSync(dir).filter((file) => file.endsWith(".md")).map((file) => file.slice(0, -3)).sort(); } catch {}
    for (const ref of refs) {
      manifestsWritten++;
      if (!dryRun) {
        const manifest = buildCacheProvenanceManifest(level, ref, { episodesDir, lineageIndex });
        writeCacheProvenanceManifest(manifest, cacheDir);
      }
    }
  }

  return {
    episodesScanned,
    episodesChanged,
    episodesUnknown,
    manifestsWritten,
    affectedDates: [...affectedDates].sort(),
  };
}
