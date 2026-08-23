import { hostname as osHostname } from "node:os";
import type { SessionLineage } from "./session-lineage.ts";

export interface EpisodeFrontmatterInput {
  origin: string;
  machine?: string;
  sourcePath: string;
  home: string;
  timestamp: string;
  lineage: SessionLineage;
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

function yamlScalar(value: string | null): string {
  return value === null ? "null" : JSON.stringify(value);
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
