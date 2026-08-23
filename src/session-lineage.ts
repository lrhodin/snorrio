// Session lineage and provenance index.
//
// `parentSession` in a child header is ancestry. Parent-side subagent_result /
// subagent_ping records are evidence-dependency edges: they may represent the
// original spawn or a later resume/consumer and therefore never overwrite
// ancestry. Provenance families are conservative connected components across
// both edge kinds.

import { existsSync, readFileSync, realpathSync, renameSync, statSync, writeFileSync, mkdirSync, unlinkSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { allSessions, sessionIdFromPath, type SessionInfo } from "./session-meta.ts";

export type LineageSource = "none" | "header" | "reverse-link" | "conflict" | "unknown";

export interface SessionLineage {
  sessionId: string;
  sessionPath: string;
  parentSessionId: string | null;
  rootSessionId: string;
  provenanceFamilyId: string;
  lineageDepth: number;
  lineageSource: LineageSource;
  lineageComplete: boolean;
  lineageConflict: boolean;
  dependencySessionIds: string[];
  issues: string[];
}

export type LineageSessionResolution =
  | { ok: true; session: SessionInfo }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; matches: SessionInfo[] };

export interface SessionLineageIndex {
  sessions: SessionLineage[];
  byPath: Map<string, SessionLineage>;
  byId: Map<string, SessionLineage>;
  traversedPaths: string[];
  getByPath(path: string): SessionLineage | null;
  getById(id: string): SessionLineage | null;
}

interface ScannedSession {
  id: string;
  path: string;
  headerParentPath: string | null;
  backlinks: string[];
  malformed: boolean;
  conflict: boolean;
}

interface ScanCacheEntry {
  size: number;
  mtimeMs: number;
  value: ScannedSession;
}

interface PersistentScanCache {
  schemaVersion: 3;
  entries: Record<string, ScanCacheEntry>;
}

const scanCache = new Map<string, ScanCacheEntry>();
let persistentLoaded = false;
let scanCacheDirty = false;
let cachedIndex: { seedPaths: string[]; fingerprint: string; value: SessionLineageIndex } | null = null;

function persistentCachePath(): string {
  const home = process.env.SNORRIO_HOME || join(process.env.HOME || "", "snorrio");
  return join(home, "cache", "session-lineage-structural-v3.json");
}

function loadPersistentCache(): void {
  if (persistentLoaded) return;
  persistentLoaded = true;
  try {
    const parsed = JSON.parse(readFileSync(persistentCachePath(), "utf8")) as PersistentScanCache;
    if (parsed.schemaVersion !== 3 || !parsed.entries) return;
    for (const [path, entry] of Object.entries(parsed.entries)) {
      if (entry && typeof entry.size === "number" && typeof entry.mtimeMs === "number" && entry.value?.id) {
        scanCache.set(path, entry);
      }
    }
  } catch {}
}

function persistStructuralCache(): void {
  if (!scanCacheDirty || process.env.SNORRIO_LINEAGE_CACHE_READONLY === "1") return;
  const path = persistentCachePath();
  const tmp = `${path}.tmp-${process.pid}`;
  try {
    mkdirSync(dirname(path), { recursive: true });
    const entries: Record<string, ScanCacheEntry> = {};
    for (const [sessionPath, entry] of scanCache) entries[sessionPath] = entry;
    writeFileSync(tmp, JSON.stringify({ schemaVersion: 3, entries } satisfies PersistentScanCache));
    renameSync(tmp, path);
    scanCacheDirty = false;
  } catch {
    try { unlinkSync(tmp); } catch {}
  }
}

export function canonicalSessionPath(path: string): string {
  const absolute = resolve(path);
  try { return realpathSync(absolute); }
  catch { return absolute; }
}

function scanSession(inputPath: string): ScannedSession | null {
  const path = canonicalSessionPath(inputPath);
  let stat;
  try { stat = statSync(path); }
  catch { return null; }

  const cached = scanCache.get(path);
  if (cached && cached.size === stat.size && cached.mtimeMs === stat.mtimeMs) return cached.value;

  let raw: string;
  try { raw = readFileSync(path, "utf8"); }
  catch { return null; }

  // Parse identity, header ancestry, and dependency records in one read. The
  // previous implementation called sessionIdFromEntries first and read the
  // transcript twice.
  let id = "";
  let headerParentPath: string | null = null;
  const backlinks: string[] = [];
  let malformed = false;
  let conflict = false;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: any;
    try { entry = JSON.parse(line); }
    catch { malformed = true; continue; }

    if (entry?.type === "session") {
      if (typeof entry.id === "string" && entry.id) id = entry.id.toLowerCase();
      if (typeof entry.parentSession === "string" && entry.parentSession) {
        if (!entry.parentSession.startsWith("/")) malformed = true;
        headerParentPath = canonicalSessionPath(entry.parentSession);
      }

      // Patched pi-herdr-subagents persists the complete root-to-self chain on
      // every child, including standalone children. This is stronger than the
      // optional Pi parentSession field and makes recursion ancestry explicit.
      const declared = entry.subagentLineage;
      if (declared != null) {
        try {
          if (declared?.version !== 1 || !declared.root || !Array.isArray(declared.chain)) throw new Error("shape");
          if (entry.subagentDepth != null && entry.subagentDepth !== declared.chain.length) throw new Error("depth");
          const paths = [declared.root.sessionFile, ...declared.chain.map((node: any) => node?.sessionFile)];
          if (paths.some((value: unknown) => typeof value !== "string" || !value)) throw new Error("path");
          const expectedDepths = declared.chain.every((node: any, index: number) => node?.depth === index + 1);
          if (!expectedDepths) throw new Error("node depth");
          if (declared.chain.length > 0) {
            const selfPath = canonicalSessionPath(paths[paths.length - 1]);
            if (selfPath !== path) throw new Error("self path");
            const lineageParent = canonicalSessionPath(paths[paths.length - 2]);
            if (headerParentPath && headerParentPath !== lineageParent) throw new Error("parent conflict");
            headerParentPath = lineageParent;
          }
        } catch {
          malformed = true;
          conflict = true;
        }
      }
    }

    if (
      entry?.type === "custom_message" &&
      (entry.customType === "subagent_result" || entry.customType === "subagent_ping")
    ) {
      const child = entry?.details?.sessionFile;
      if (typeof child === "string" && child) backlinks.push(canonicalSessionPath(child));
      else if (entry.details && Object.prototype.hasOwnProperty.call(entry.details, "sessionFile")) malformed = true;
    }
  }

  id ||= sessionIdFromPath(path) ?? "";
  if (!id) return null;
  const value = {
    id: id.toLowerCase(),
    path,
    headerParentPath,
    backlinks: [...new Set(backlinks)].sort(),
    malformed,
    conflict,
  };
  scanCache.set(path, { size: stat.size, mtimeMs: stat.mtimeMs, value });
  scanCacheDirty = true;
  return value;
}

function pathsFingerprint(paths: string[]): string {
  return [...new Set(paths.map(canonicalSessionPath))].sort().map((path) => {
    try {
      const stat = statSync(path);
      return `${path}\0${stat.size}\0${stat.mtimeMs}`;
    } catch {
      return `${path}\0missing`;
    }
  }).join("\n");
}

class DisjointSet {
  private parent = new Map<string, string>();
  add(value: string) { if (!this.parent.has(value)) this.parent.set(value, value); }
  find(value: string): string {
    const parent = this.parent.get(value) ?? value;
    if (parent === value) return value;
    const root = this.find(parent);
    this.parent.set(value, root);
    return root;
  }
  union(a: string, b: string) {
    this.add(a); this.add(b);
    const ar = this.find(a), br = this.find(b);
    if (ar !== br) this.parent.set(br, ar);
  }
}

export function buildSessionLineageIndex(seedSessions: SessionInfo[]): SessionLineageIndex {
  const scannedByPath = new Map<string, ScannedSession>();
  const referencedPaths = new Set<string>();
  const queue = seedSessions.map((session) => canonicalSessionPath(session.path));

  // Follow both directions available from structural records. This discovers
  // project-local children, their external descendants, and external ancestors.
  while (queue.length > 0) {
    const path = queue.shift()!;
    if (scannedByPath.has(path)) continue;
    const scanned = scanSession(path);
    if (!scanned) continue;
    scannedByPath.set(path, scanned);
    for (const childPath of scanned.backlinks) {
      referencedPaths.add(childPath);
      if (!scannedByPath.has(childPath) && existsSync(childPath)) queue.push(childPath);
    }
    if (scanned.headerParentPath) {
      referencedPaths.add(scanned.headerParentPath);
      if (!scannedByPath.has(scanned.headerParentPath) && existsSync(scanned.headerParentPath)) {
        queue.push(scanned.headerParentPath);
      }
    }
  }

  const idPaths = new Map<string, string[]>();
  for (const session of scannedByPath.values()) {
    const paths = idPaths.get(session.id) ?? [];
    paths.push(session.path);
    idPaths.set(session.id, paths);
  }

  const dependencyNeighbors = new Map<string, Set<string>>();
  const dependencyMissing = new Set<string>();
  const addDependency = (a: string, b: string) => {
    const an = dependencyNeighbors.get(a) ?? new Set<string>();
    const bn = dependencyNeighbors.get(b) ?? new Set<string>();
    an.add(b); bn.add(a);
    dependencyNeighbors.set(a, an); dependencyNeighbors.set(b, bn);
  };
  for (const consumer of scannedByPath.values()) {
    for (const childPath of consumer.backlinks) {
      if (scannedByPath.has(childPath)) addDependency(consumer.path, childPath);
      else dependencyMissing.add(consumer.path);
    }
  }

  interface AncestryState {
    rootPath: string;
    depth: number;
    complete: boolean;
    conflict: boolean;
    issues: string[];
  }
  const ancestry = new Map<string, AncestryState>();

  for (const start of scannedByPath.keys()) {
    if (ancestry.has(start)) continue;
    const chain: string[] = [];
    const positions = new Map<string, number>();
    let cursor: string | null = start;
    let terminal: string | null = null;
    let cycleStart = -1;

    while (cursor) {
      if (ancestry.has(cursor)) { terminal = cursor; break; }
      const seen = positions.get(cursor);
      if (seen !== undefined) { cycleStart = seen; break; }
      positions.set(cursor, chain.length);
      chain.push(cursor);
      const parent: string | null = scannedByPath.get(cursor)?.headerParentPath ?? null;
      cursor = parent && scannedByPath.has(parent) ? parent : null;
    }

    if (cycleStart >= 0) {
      const cyclePaths = chain.slice(cycleStart);
      const rootPath = [...cyclePaths].sort((a, b) =>
        scannedByPath.get(a)!.id.localeCompare(scannedByPath.get(b)!.id) || a.localeCompare(b)
      )[0];
      for (let i = chain.length - 1; i >= 0; i--) {
        ancestry.set(chain[i], {
          rootPath,
          depth: i < cycleStart ? cycleStart - i : 0,
          complete: false,
          conflict: true,
          issues: ["ancestry cycle detected"],
        });
      }
      continue;
    }

    let parentState = terminal ? ancestry.get(terminal)! : null;
    for (let i = chain.length - 1; i >= 0; i--) {
      const path = chain[i];
      const scanned = scannedByPath.get(path)!;
      const issues: string[] = [];
      let conflict = scanned.conflict;
      if (scanned.malformed) issues.push("malformed session or lineage record");
      if ((idPaths.get(scanned.id)?.length ?? 0) > 1) {
        issues.push(`duplicate canonical session id ${scanned.id}`);
        conflict = true;
      }
      const parentMissing = Boolean(scanned.headerParentPath && !scannedByPath.has(scanned.headerParentPath));
      if (parentMissing) issues.push("header parent is missing or unreadable");
      if (dependencyMissing.has(path)) issues.push("dependency target is missing or unreadable");
      const state: AncestryState = {
        rootPath: parentState?.rootPath ?? path,
        depth: parentState ? parentState.depth + 1 : 0,
        complete: issues.length === 0 && !parentMissing && (parentState?.complete ?? true),
        conflict: conflict || (parentState?.conflict ?? false),
        issues,
      };
      ancestry.set(path, state);
      parentState = state;
    }
  }

  // Provenance family is a connected component across ancestry AND evidence
  // dependency. A resumed session consumed by several parents remains one
  // evidence source rather than becoming several apparent witnesses.
  const components = new DisjointSet();
  for (const path of scannedByPath.keys()) components.add(path);
  for (const session of scannedByPath.values()) {
    if (session.headerParentPath && scannedByPath.has(session.headerParentPath)) components.union(session.path, session.headerParentPath);
    for (const dependency of dependencyNeighbors.get(session.path) ?? []) components.union(session.path, dependency);
  }

  const componentMembers = new Map<string, string[]>();
  for (const path of scannedByPath.keys()) {
    const root = components.find(path);
    const members = componentMembers.get(root) ?? [];
    members.push(path);
    componentMembers.set(root, members);
  }

  const familyByPath = new Map<string, { id: string; complete: boolean; conflict: boolean }>();
  for (const members of componentMembers.values()) {
    // Prefer an ancestry root as the stable family identity. Components can
    // contain several roots when multiple sessions consume the same child; in
    // that case choose deterministically among those roots.
    const roots = members.filter((path) => ancestry.get(path)!.depth === 0);
    const candidates = roots.length ? roots : members;
    const sorted = [...candidates].sort((a, b) =>
      scannedByPath.get(a)!.id.localeCompare(scannedByPath.get(b)!.id) || a.localeCompare(b)
    );
    const id = scannedByPath.get(sorted[0])!.id;
    const complete = members.every((path) => ancestry.get(path)!.complete);
    const conflict = members.some((path) => ancestry.get(path)!.conflict);
    for (const path of members) familyByPath.set(path, { id, complete, conflict });
  }

  const byPath = new Map<string, SessionLineage>();
  for (const session of scannedByPath.values()) {
    const state = ancestry.get(session.path)!;
    const family = familyByPath.get(session.path)!;
    const dependencyIds = [...(dependencyNeighbors.get(session.path) ?? [])]
      .map((path) => scannedByPath.get(path)!.id).sort();
    const hasHeader = Boolean(session.headerParentPath);
    const source: LineageSource = state.conflict ? "conflict"
      : hasHeader ? "header"
      : dependencyIds.length ? "reverse-link"
      : "none";
    const lineage: SessionLineage = {
      sessionId: session.id,
      sessionPath: session.path,
      parentSessionId: session.headerParentPath ? scannedByPath.get(session.headerParentPath)?.id ?? null : null,
      rootSessionId: scannedByPath.get(state.rootPath)?.id ?? session.id,
      provenanceFamilyId: family.id,
      lineageDepth: state.depth,
      lineageSource: source,
      lineageComplete: family.complete,
      lineageConflict: family.conflict,
      dependencySessionIds: dependencyIds,
      issues: [...state.issues],
    };
    byPath.set(session.path, lineage);
  }

  const sessions = [...byPath.values()].sort((a, b) => a.sessionPath.localeCompare(b.sessionPath));
  const byId = new Map<string, SessionLineage>();
  for (const lineage of sessions) {
    if ((idPaths.get(lineage.sessionId)?.length ?? 0) === 1) byId.set(lineage.sessionId, lineage);
  }
  return {
    sessions,
    byPath,
    byId,
    // Include missing-but-referenced paths. Their fingerprint changes from
    // `missing` when the file appears, so a cached index discovers late-created
    // children without waiting for an unrelated session mutation or restart.
    traversedPaths: [...new Set([...scannedByPath.keys(), ...referencedPaths])].sort(),
    getByPath(path: string) { return byPath.get(canonicalSessionPath(path)) ?? null; },
    getById(id: string) { return byId.get(id.toLowerCase()) ?? null; },
  };
}

export function getSessionLineageIndex(sessions: SessionInfo[] = allSessions()): SessionLineageIndex {
  loadPersistentCache();
  const seedPaths = sessions.map((session) => canonicalSessionPath(session.path)).sort();
  const validityPaths = cachedIndex
    ? [...new Set([...seedPaths, ...cachedIndex.value.traversedPaths])]
    : seedPaths;
  const fingerprint = pathsFingerprint(validityPaths);
  if (cachedIndex && cachedIndex.fingerprint === fingerprint && cachedIndex.seedPaths.join("\n") === seedPaths.join("\n")) {
    return cachedIndex.value;
  }
  const value = buildSessionLineageIndex(sessions);
  const fullFingerprint = pathsFingerprint([...seedPaths, ...value.traversedPaths]);
  cachedIndex = { seedPaths, fingerprint: fullFingerprint, value };
  persistStructuralCache();
  return value;
}

export function resolveLineageSession(ref: string, index: SessionLineageIndex = getSessionLineageIndex()): LineageSessionResolution {
  const needle = ref.toLowerCase();
  const exact = index.byId.get(needle);
  if (exact) return { ok: true, session: { id: exact.sessionId, path: exact.sessionPath } };
  const matches = index.sessions
    .filter((lineage) => lineage.sessionId.startsWith(needle))
    .map((lineage) => ({ id: lineage.sessionId, path: lineage.sessionPath }));
  if (matches.length === 1) return { ok: true, session: matches[0] };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", matches };
  return { ok: false, reason: "not_found" };
}

export function __clearLineageCacheForTest(): void {
  scanCache.clear();
  persistentLoaded = false;
  scanCacheDirty = false;
  cachedIndex = null;
}
