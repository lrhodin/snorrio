import { hostname as osHostname } from "node:os";
import type { SessionLineage } from "./session-lineage.ts";

/**
 * How the zone recorded in `tz` was established.
 *   journal — read from the session's own record at generation time
 *   system  — the machine's zone at generation time (config, else the host)
 *   assumed — reconstructed after the fact; the zone is our best claim, not a
 *             measurement. Historical backfill uses this rather than dressing an
 *             inference as an observation.
 */
export type TimezoneSource = "journal" | "system" | "assumed";

export interface EpisodeLocalDate {
  /** YYYY-MM-DD. The bucketing key: written once, never recomputed. */
  localDate: string;
  /** IANA zone name in effect at that instant, e.g. "America/Los_Angeles". */
  tz: string;
  /** Resolved offset for human readability, e.g. "-07:00". Never used for arithmetic. */
  utcOffset: string;
  tzSource: TimezoneSource;
}

export interface EpisodeFrontmatterInput {
  origin: string;
  machine?: string;
  sourcePath: string;
  home: string;
  timestamp: string;
  lineage: SessionLineage;
  localDate: EpisodeLocalDate;
}

export interface ParsedEpisodeFrontmatter {
  fields: Map<string, string>;
  hasFrontmatter: boolean;
  prose: string;
}

export const LINEAGE_FRONTMATTER_KEYS = [
  "lineage_metadata_version",
  "session_id",
  "parent_session_id",
  "root_session_id",
  "provenance_family_id",
  "lineage_depth",
  "lineage_source",
  "lineage_complete",
  "lineage_conflict",
  "dependency_session_ids",
] as const;

// Written once at generation time and then immutable — the same rule the vault
// applies to dated records. `local_date` is the authoritative bucket for an
// episode: recomputing it from a timestamp makes an episode's identity depend on
// where the machine currently is, which is precisely the defect that made a
// timezone change destructive.
export const LOCAL_DATE_FRONTMATTER_KEYS = [
  "local_date",
  "tz",
  "utc_offset",
  "tz_source",
] as const;

function yamlScalar(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
}

function localDateLines(localDate: EpisodeLocalDate): string[] {
  return [
    `local_date: ${yamlScalar(localDate.localDate)}`,
    `tz: ${yamlScalar(localDate.tz)}`,
    `utc_offset: ${yamlScalar(localDate.utcOffset)}`,
    `tz_source: ${yamlScalar(localDate.tzSource)}`,
  ];
}

function lineageLines(lineage: SessionLineage): string[] {
  return [
    "lineage_metadata_version: 1",
    `session_id: ${yamlScalar(lineage.sessionId)}`,
    `parent_session_id: ${yamlScalar(lineage.parentSessionId)}`,
    `root_session_id: ${yamlScalar(lineage.rootSessionId)}`,
    `provenance_family_id: ${yamlScalar(lineage.provenanceFamilyId)}`,
    `lineage_depth: ${lineage.lineageDepth}`,
    `lineage_source: ${yamlScalar(lineage.lineageSource)}`,
    `lineage_complete: ${lineage.lineageComplete}`,
    `lineage_conflict: ${lineage.lineageConflict}`,
    `dependency_session_ids: ${JSON.stringify(lineage.dependencySessionIds)}`,
  ];
}

export function defaultMachine(): string {
  return osHostname().replace(/\.local$/, "").toLowerCase();
}

export function parseEpisodeFrontmatter(content: string): ParsedEpisodeFrontmatter {
  if (!content.startsWith("---\n")) return { fields: new Map(), hasFrontmatter: false, prose: content };
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return { fields: new Map(), hasFrontmatter: false, prose: content };
  const raw = content.slice(4, end);
  const fields = new Map<string, string>();
  for (const line of raw.split("\n")) {
    const match = line.match(/^([A-Za-z0-9_-]+):\s*(.*)$/);
    if (match) fields.set(match[1], match[2].trim());
  }
  return { fields, hasFrontmatter: true, prose: content.slice(end + "\n---\n".length) };
}

export function buildEpisodeFrontmatter(input: EpisodeFrontmatterInput): string {
  const source = input.sourcePath.startsWith(input.home)
    ? "~" + input.sourcePath.slice(input.home.length)
    : input.sourcePath;
  return [
    "---",
    `origin: ${yamlScalar(input.origin)}`,
    `machine: ${yamlScalar(input.machine ?? defaultMachine())}`,
    `source: ${yamlScalar(source)}`,
    `timestamp: ${yamlScalar(input.timestamp)}`,
    ...localDateLines(input.localDate),
    ...lineageLines(input.lineage),
    "---",
    "",
    "",
  ].join("\n");
}

// Metadata-only migration. Existing non-lineage frontmatter and every prose byte
// after the closing delimiter are preserved exactly. Existing lineage keys are
// replaced, making the operation idempotent.
export function upsertEpisodeLineageMetadata(
  content: string,
  lineage: SessionLineage,
  base?: Omit<EpisodeFrontmatterInput, "lineage">,
): string {
  if (!content.startsWith("---\n")) {
    if (!base) throw new Error("base frontmatter is required for an episode without frontmatter");
    const frontmatter = buildEpisodeFrontmatter({ ...base, lineage });
    // buildEpisodeFrontmatter leaves a conventional blank line before newly
    // generated prose. During migration, preserve the pre-existing prose bytes
    // exactly as the parser-visible body instead of inserting a new leading LF.
    return (frontmatter.endsWith("\n\n") ? frontmatter.slice(0, -1) : frontmatter) + content;
  }
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("malformed episode frontmatter");
  const existing = content.slice(4, end).split("\n");
  const lineageKeys = new Set<string>(LINEAGE_FRONTMATTER_KEYS);
  const kept = existing.filter((line) => {
    const key = line.match(/^([A-Za-z0-9_-]+):/)?.[1];
    return !key || !lineageKeys.has(key as any);
  });
  const prefix = `---\n${[...kept, ...lineageLines(lineage)].join("\n")}\n---\n`;
  return prefix + content.slice(end + "\n---\n".length);
}

// Metadata-only backfill of the local-date block, same contract as
// upsertEpisodeLineageMetadata: every prose byte after the closing delimiter is
// preserved exactly, unrelated frontmatter keys are left alone, and re-running
// is a no-op because the four keys are replaced rather than appended.
//
// Deliberately NOT idempotent-by-recompute: it writes the local_date it is
// given. The backfill passes the directory the episode already sits in, which
// freezes history as it stands instead of re-deriving a date that would move
// with the machine's zone.
export function upsertEpisodeLocalDate(content: string, localDate: EpisodeLocalDate): string {
  if (!content.startsWith("---\n")) {
    throw new Error("cannot add local_date to an episode without frontmatter");
  }
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) throw new Error("malformed episode frontmatter");
  const existing = content.slice(4, end).split("\n");
  const keys = new Set<string>(LOCAL_DATE_FRONTMATTER_KEYS);
  const lines = localDateLines(localDate);
  const kept: string[] = [];
  let replacedAt = -1;
  for (const line of existing) {
    const key = line.match(/^([A-Za-z0-9_-]+):/)?.[1];
    if (key && keys.has(key)) {
      // Rewrite the block where it already sits, so a second run produces the
      // same bytes rather than migrating the keys to the end of the block.
      if (replacedAt < 0) replacedAt = kept.length;
      continue;
    }
    kept.push(line);
  }
  if (replacedAt < 0) kept.push(...lines);
  else kept.splice(replacedAt, 0, ...lines);
  return `---\n${kept.join("\n")}\n---\n` + content.slice(end + "\n---\n".length);
}
