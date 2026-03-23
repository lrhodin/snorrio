// Session metadata scanner — reads JSONL structural fields, never content blocks.
//
// Supports both pi and CC session formats:
//   pi:  ~/.pi/agent/sessions/<project>/<timestamp>_<uuid>.jsonl
//   cc:  ~/.claude/projects/<project-key>/<uuid>.jsonl
//
// Exports lightweight metadata functions shared by daemon and recall engine.

import { readFileSync, readdirSync, existsSync } from "fs";
import { join, basename } from "path";

const HOME = process.env.HOME!;
const PI_SESSIONS_DIR = join(HOME, ".pi/agent/sessions");
const CC_PROJECTS_DIR = join(HOME, ".claude/projects");

export type Platform = "pi" | "cc";

export interface SessionInfo {
  path: string;
  platform: Platform;
  id: string;
}

// ============================================================================
// PLATFORM DETECTION
// ============================================================================

export function detectPlatform(filePath: string): Platform {
  if (filePath.includes(".claude/projects")) return "cc";
  return "pi";
}

// ============================================================================
// SESSION ID
// ============================================================================

// Pi filenames: 2026-03-20T03-50-09-944Z_<uuid>.jsonl
// CC filenames: <uuid>.jsonl
export function sessionIdFromPath(filePath: string): string | null {
  const name = basename(filePath, ".jsonl");
  const platform = detectPlatform(filePath);

  if (platform === "cc") {
    // CC: filename IS the uuid
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(name) ? name : null;
  }

  // Pi: extract uuid after the timestamp prefix
  const match = name.match(/_([0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})$/);
  return match ? match[1] : null;
}

// Pi: session ID from entry with type "session"
// CC: sessionId field on any entry
export function sessionIdFromEntries(filePath: string): string | null {
  const platform = detectPlatform(filePath);
  const lines = readFirstLines(filePath, 5);

  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (platform === "pi" && entry.type === "session" && entry.id) return entry.id;
      if (platform === "cc" && entry.sessionId) return entry.sessionId;
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
  const platform = detectPlatform(filePath);
  const raw = readFileSync(filePath, "utf8");

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try {
      const entry = JSON.parse(line);
      // Pi: type "message" with message.role "assistant"
      if (platform === "pi" && entry.type === "message" && entry.message?.role === "assistant") return true;
      // CC: type "assistant"
      if (platform === "cc" && entry.type === "assistant") return true;
    } catch {}
  }

  return false;
}

// ============================================================================
// CWD EXTRACTION (CC only — for claude --resume)
// ============================================================================

export function extractCwd(filePath: string): string | null {
  const lines = readFirstLines(filePath, 5);
  for (const line of lines) {
    try {
      const entry = JSON.parse(line);
      if (entry.cwd) return entry.cwd;
    } catch {}
  }
  return null;
}

// ============================================================================
// SESSION DISCOVERY
// ============================================================================

export function findSession(ref: string): SessionInfo | null {
  const refLower = ref.toLowerCase();

  // Check pi sessions
  if (existsSync(PI_SESSIONS_DIR)) {
    const result = walkForSession(PI_SESSIONS_DIR, refLower, "pi");
    if (result) return result;
  }

  // Check CC sessions
  if (existsSync(CC_PROJECTS_DIR)) {
    try {
      for (const projectDir of readdirSync(CC_PROJECTS_DIR, { withFileTypes: true })) {
        if (!projectDir.isDirectory()) continue;
        const projectPath = join(CC_PROJECTS_DIR, projectDir.name);
        const result = walkForSession(projectPath, refLower, "cc");
        if (result) return result;
      }
    } catch {}
  }

  return null;
}

function walkForSession(dir: string, id: string, platform: Platform): SessionInfo | null {
  try {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        const result = walkForSession(full, id, platform);
        if (result) return result;
      } else if (item.name.endsWith(".jsonl") && item.name.toLowerCase().includes(id)) {
        const sessionId = sessionIdFromPath(full);
        if (sessionId) return { path: full, platform, id: sessionId };
      }
    }
  } catch {}
  return null;
}

// Resolve a UUID prefix to full UUID (CC needs full UUIDs)
export function resolveFullId(ref: string): SessionInfo | null {
  return findSession(ref);
}

// ============================================================================
// ALL SESSIONS (for daemon sweep)
// ============================================================================

export function allSessions(): SessionInfo[] {
  const sessions: SessionInfo[] = [];

  // Pi sessions
  if (existsSync(PI_SESSIONS_DIR)) {
    walkAll(PI_SESSIONS_DIR, "pi", sessions);
  }

  // CC sessions
  if (existsSync(CC_PROJECTS_DIR)) {
    try {
      for (const projectDir of readdirSync(CC_PROJECTS_DIR, { withFileTypes: true })) {
        if (!projectDir.isDirectory()) continue;
        const projectPath = join(CC_PROJECTS_DIR, projectDir.name);
        // Only scan top-level JSONL files in each project dir (skip subdirectories like subagents/)
        try {
          for (const item of readdirSync(projectPath, { withFileTypes: true })) {
            if (!item.isFile() || !item.name.endsWith(".jsonl")) continue;
            const full = join(projectPath, item.name);
            const id = sessionIdFromPath(full);
            if (id) sessions.push({ path: full, platform: "cc", id });
          }
        } catch {}
      }
    } catch {}
  }

  return sessions;
}

function walkAll(dir: string, platform: Platform, out: SessionInfo[]) {
  try {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) {
        walkAll(full, platform, out);
      } else if (item.name.endsWith(".jsonl")) {
        const id = sessionIdFromPath(full);
        if (id) out.push({ path: full, platform, id });
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
