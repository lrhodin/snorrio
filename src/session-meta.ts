// Session metadata scanner — reads JSONL structural fields, never content blocks.
//
// Pi session format: ~/.pi/agent/sessions/<project>/<timestamp>_<uuid>.jsonl
//
// Exports lightweight metadata functions shared by daemon and recall engine.

import { readFileSync, readdirSync, existsSync } from "fs";
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

// Pi filenames: 2026-03-20T03-50-09-944Z_<uuid>.jsonl
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

export function findSession(ref: string): SessionInfo | null {
  const refLower = ref.toLowerCase();

  if (existsSync(PI_SESSIONS_DIR)) {
    const result = walkForSession(PI_SESSIONS_DIR, refLower);
    if (result) return result;
  }

  return null;
}

function walkForSession(dir: string, id: string): SessionInfo | null {
  try {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        const result = walkForSession(full, id);
        if (result) return result;
      } else if (item.name.endsWith(".jsonl") && item.name.toLowerCase().includes(id)) {
        const sessionId = sessionIdFromPath(full);
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
// ALL SESSIONS (for daemon sweep)
// ============================================================================

export function allSessions(): SessionInfo[] {
  const sessions: SessionInfo[] = [];

  if (existsSync(PI_SESSIONS_DIR)) {
    walkAll(PI_SESSIONS_DIR, sessions);
  }

  return sessions;
}

function walkAll(dir: string, out: SessionInfo[]) {
  try {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        walkAll(full, platform, out);
      } else if (item.name.endsWith(".jsonl")) {
        const id = sessionIdFromPath(full);
        if (id) out.push({ path: full, id });
      }
    }
  } catch {}
}

// ============================================================================
// HELPERS
// ============================================================================

function readFirstLines(filePath: string, n: number): string[] {
  const raw = readFileSync(filePath, "utf8");
  const lines: string[] = [];
  let start = 0;
  for (let i = 0; i < n; i++) {
    const end = raw.indexOf("\n", start);
    if (end === -1) {
      if (start < raw.length) lines.push(raw.slice(start));
      break;
    }
    lines.push(raw.slice(start, end));
    start = end + 1;
  }
  return lines;
}
