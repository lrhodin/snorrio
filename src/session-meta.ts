// Session metadata scanner — reads JSONL structural fields, never content blocks.
//
// Pi session format: ~/.pi/agent/sessions/<project>/<timestamp>_<uuid>.jsonl
//
// Exports lightweight metadata functions shared by daemon and recall engine.

import { readFileSync, readdirSync, existsSync, openSync, readSync, closeSync } from "fs";
import { join, basename } from "path";

const HOME = process.env.HOME!;
const PI_SESSIONS_DIR = join(HOME, ".pi/agent/sessions");

export interface SessionInfo {
  path: string;
  id: string;
}

// ============================================================================
// SESSION ID
// ============================================================================

// Pi writes session filenames in two shapes:
//   2026-07-22T19-29-23-890Z_019f8b4d-ddb2-7808-86a0-1b251f8021fc.jsonl  (uuid)
//   2026-07-22T19-52-14-788Z_dc2f4859-afd8bb8f-db1b0151-9d43.jsonl       (4-part)
// Only the first carries the session's internal id, and even that is not
// guaranteed to agree with the header (one file on this box does not). So the
// filename is a hint, never the identity — see sessionIdFromEntries.
export function sessionIdFromPath(filePath: string): string | null {
  const name = basename(filePath, ".jsonl");
  const match = name.match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  return match ? match[1] : null;
}

export function sessionIdFromEntries(filePath: string): string | null {
  const lines = readFirstLines(filePath, 5);

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.type === "session" && entry.id) return entry.id;
    } catch {}
  }

  // Fallback to filename
  return sessionIdFromPath(filePath);
}

// ============================================================================
// TIMESTAMPS
// ============================================================================

export function sessionTimestamps(filePath: string): { start: string | null; end: string | null } {
  const raw = readFileSync(filePath, "utf8");
  let earliest = Infinity;
  let latest = -Infinity;

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      const ts = entry.timestamp;
      if (!ts) continue;
      const t = new Date(ts).getTime();
      if (isNaN(t)) continue;
      if (t < earliest) earliest = t;
      if (t > latest) latest = t;
    } catch {}
  }

  return {
    start: earliest === Infinity ? null : new Date(earliest).toISOString(),
    end: latest === -Infinity ? null : new Date(latest).toISOString(),
  };
}

// ============================================================================
// HAS ASSISTANT MESSAGE
// ============================================================================

export function hasAssistantMessage(filePath: string): boolean {
  const raw = readFileSync(filePath, "utf8");

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      if (entry.type === "message" && entry.message?.role === "assistant") return true;
    } catch {}
  }

  return false;
}

// ============================================================================
// SESSION DISCOVERY
// ============================================================================

// Resolution is keyed on the SAME identity the daemon names episodes with —
// the internal id from the JSONL header (sessionIdFromEntries). Resolving by
// filename substring instead (the pre-2026-07-29 behaviour) made every
// 4-part-named session permanently unresolvable: 194 of 299 on this box, i.e.
// 62% of episodes were un-drillable even though the session was right there.
export type SessionResolution =
  | { ok: true; session: SessionInfo }
  | { ok: false; reason: "not_found" }
  | { ok: false; reason: "ambiguous"; matches: SessionInfo[] };

export function resolveSession(ref: string): SessionResolution {
  const refLower = ref.toLowerCase();
  const index = sessionIdIndex();

  // Exact id wins outright, even if it is also a prefix of another id.
  const exact = index.get(refLower);
  if (exact) return { ok: true, session: { path: exact, id: refLower } };

  // Prefix match. Short prefixes DO collide (24 eight-char collisions on this
  // box), so report the ambiguity rather than silently picking one.
  const matches: SessionInfo[] = [];
  for (const [id, path] of index) {
    if (id.startsWith(refLower)) matches.push({ path, id });
  }
  if (matches.length === 1) return { ok: true, session: matches[0] };
  if (matches.length > 1) return { ok: false, reason: "ambiguous", matches };

  // Last resort: filename substring, which is how refs used to resolve. Kept so
  // a pasted filename fragment (including the 4-part token, which appears in no
  // header) still works — but the id returned is always the canonical one.
  const byName = existsSync(PI_SESSIONS_DIR) ? walkForFilename(PI_SESSIONS_DIR, refLower) : null;
  if (byName) return { ok: true, session: byName };

  return { ok: false, reason: "not_found" };
}

export function findSession(ref: string): SessionInfo | null {
  const result = resolveSession(ref);
  return result.ok ? result.session : null;
}

function walkForFilename(dir: string, id: string): SessionInfo | null {
  try {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        const result = walkForFilename(full, id);
        if (result) return result;
      } else if (item.name.endsWith(".jsonl") && item.name.toLowerCase().includes(id)) {
        const sessionId = sessionIdFromEntries(full);
        if (sessionId) return { path: full, id: sessionId };
      }
    }
  } catch {}
  return null;
}

export function resolveFullId(ref: string): SessionInfo | null {
  return findSession(ref);
}

// ============================================================================
// SESSION ID INDEX
// ============================================================================

// path -> canonical id. A session's header is written once at creation and
// never changes, so this is safe to cache for the life of the process; the
// directory walk is re-done on every call so a long-running daemon still sees
// new sessions. Header reads are the expensive part (~28ms cold for 299 files,
// ~0 warm), the walk is not.
const idByPath = new Map<string, string>();

// canonical id -> path, for every session file on disk.
export function sessionIdIndex(): Map<string, string> {
  const index = new Map<string, string>();
  for (const path of sessionFiles()) {
    let id = idByPath.get(path);
    if (id === undefined) {
      id = sessionIdFromEntries(path) ?? "";
      idByPath.set(path, id);
    }
    if (id) index.set(id.toLowerCase(), path);
  }
  return index;
}

function sessionFiles(): string[] {
  const out: string[] = [];
  if (!existsSync(PI_SESSIONS_DIR)) return out;
  (function walk(dir: string) {
    try {
      for (const item of readdirSync(dir, { withFileTypes: true })) {
        const full = join(dir, item.name);
        if (item.isDirectory()) walk(full);
        else if (item.name.endsWith(".jsonl")) out.push(full);
      }
    } catch {}
  })(PI_SESSIONS_DIR);
  return out;
}

// ============================================================================
// ALL SESSIONS (for daemon sweep)
// ============================================================================

// Keyed on the canonical id too — previously this returned only the 105
// uuid-named sessions, so sweep/flush/reprocess were blind to the other 194
// and `flush`'s "true by construction" guarantee was silently false for them.
export function allSessions(): SessionInfo[] {
  return [...sessionIdIndex()].map(([id, path]) => ({ path, id }));
}

// ============================================================================
// HELPERS
// ============================================================================

// Bounded read: sessions run to megabytes and this is now called once per file
// when building the id index, so read chunks until we have n lines rather than
// slurping the whole file (~28ms vs ~235ms across 299 sessions).
function readFirstLines(filePath: string, n: number): string[] {
  const CHUNK = 64 * 1024;
  const CAP = 1024 * 1024;
  let fd: number;
  try { fd = openSync(filePath, "r"); }
  catch { return []; }
  try {
    const buf = Buffer.alloc(CHUNK);
    let raw = "";
    while (raw.length < CAP) {
      const read = readSync(fd, buf, 0, CHUNK, null);
      if (read <= 0) break;
      raw += buf.toString("utf8", 0, read);
      // n complete lines requires n newlines; split length is newlines + 1.
      if (raw.split("\n").length > n) break;
    }
    const lines = raw.split("\n");
    // Drop a trailing partial line unless it is all we have.
    if (lines.length > 1 && raw.length >= CAP) lines.pop();
    return lines.slice(0, n);
  } finally {
    closeSync(fd);
  }
}
