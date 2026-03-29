#!/usr/bin/env node
// recall-engine — unified recall across sessions, days, weeks, months, quarters.
//
// Sessions use buildSessionContext + complete(). Temporal ops load
// episode markdown through complete().
//
// Refs:
//   session UUID or .jsonl path → load session context
//   YYYY-MM-DD                  → load all episodes for that day
//   YYYY-Www                    → load cached day summaries for that week
//   YYYY-MM                     → load cached week summaries for that month
//   YYYY-QN                     → load cached month summaries for that quarter
//
// Usage:
//   recall <ref> "question"
//   recall 2026-03-05 "What shipped today?"
//   recall 2026-W09 "What was the main thread?"

import { readFileSync, readdirSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { complete, stream as aiStream, getText, userMessage, SNORRIO_HOME, piRoot, getTimezone } from "./ai.ts";
import { findSession, sessionIdFromPath, type SessionInfo } from "./session-meta.ts";

const HOME = process.env.HOME!;
const PI_SESSIONS_DIR = join(HOME, ".pi/agent/sessions");
const EPISODES_DIR = join(SNORRIO_HOME, "episodes");
const CACHE_DIR = join(SNORRIO_HOME, "cache");

// Lazy pi imports — only loaded when processing pi sessions
let _piSessionManager: any;

async function getPiSessionManager() {
  if (!_piSessionManager) {
    const root = piRoot();
    if (!root) throw new Error("pi not installed — cannot process pi sessions");
    _piSessionManager = await import(join(root, "dist/core/session-manager.js"));
  }
  return _piSessionManager;
}

// ============================================================================
// REF DETECTION
// ============================================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const QUARTER_RE = /^\d{4}-Q[1-4]$/;
const YEAR_RE = /^\d{4}$/;

function refType(ref: string) {
  if (DATE_RE.test(ref)) return "day";
  if (WEEK_RE.test(ref)) return "week";
  if (QUARTER_RE.test(ref)) return "quarter";
  if (MONTH_RE.test(ref)) return "month";
  if (YEAR_RE.test(ref)) return "year";
  return "session";
}

// ============================================================================
// TEMPORAL CONTEXT — situated witness mode
// ============================================================================

function extractTimestamp(sessionFile: string): Date | null {
  const basename = sessionFile.split("/").pop();
  const match = basename?.match(/^(\d{4})-(\d{2})-(\d{2})T(\d{2})-(\d{2})-(\d{2})-(\d{3})Z_/);
  if (!match) return null;
  const [, y, mo, d, h, mi, s, ms] = match;
  return new Date(`${y}-${mo}-${d}T${h}:${mi}:${s}.${ms}Z`);
}

function loadTemporalContext(timestamp: Date): string {
  const tz = getTimezone();
  const pt = new Date(timestamp.toLocaleString("en-US", { timeZone: tz }));

  const today = `${pt.getFullYear()}-${String(pt.getMonth() + 1).padStart(2, "0")}-${String(pt.getDate()).padStart(2, "0")}`;

  const dayOfYear = Math.floor((pt.getTime() - new Date(pt.getFullYear(), 0, 1).getTime()) / 86400000) + 1;
  const dow = pt.getDay() || 7;
  const wn = Math.floor((dayOfYear - dow + 10) / 7);
  let wy = pt.getFullYear();
  if (wn < 1) wy--;
  const week = `${wy}-W${String(Math.max(1, wn)).padStart(2, "0")}`;

  const month = today.slice(0, 7);
  const m = pt.getMonth();
  const q = Math.floor(m / 3) + 1;
  const quarter = `${pt.getFullYear()}-Q${q}`;

  function readCache(level: string, key: string): string | null {
    try {
      return readFileSync(join(CACHE_DIR, level, `${key}.md`), "utf8").trim() || null;
    } catch { return null; }
  }

  const year = `${pt.getFullYear()}`;

  const sections: string[] = [];
  const dayCtx = readCache("days", today);
  if (dayCtx) sections.push(`### That day (${today})\n${dayCtx}`);
  const weekCtx = readCache("weeks", week);
  if (weekCtx) sections.push(`### That week (${week})\n${weekCtx}`);
  const monthCtx = readCache("months", month);
  if (monthCtx) sections.push(`### That month (${month})\n${monthCtx}`);
  const quarterCtx = readCache("quarters", quarter);
  if (quarterCtx) sections.push(`### That quarter (${quarter})\n${quarterCtx}`);
  const yearCtx = readCache("years", year);
  if (yearCtx) sections.push(`### That year (${year})\n${yearCtx}`);

  if (sections.length === 0) return "";
  return `\n\n## Temporal context (what was happening when this session ran)\n\n${sections.join("\n\n")}\n`;
}

// ============================================================================
// SESSION RECALL
// ============================================================================

const RECALL_SYSTEM = `You are being revived to answer questions about a past session. You have full context from your original conversation — you're not reading a log, you're remembering.

Answer directly from your experience. Be precise — include exact commands, error messages, file paths, numbers. When you know which subordinate sessions or dates are relevant, name them so the caller can drill in.

If you don't know something, say so.`;

async function recallPiSession(sessionFile: string, question: string, modelSpec: string, options: { context?: boolean; onChunk?: OnChunk } = {}) {
  const { loadEntriesFromFile, buildSessionContext } = await getPiSessionManager();

  const entries = loadEntriesFromFile(sessionFile);
  const sessionEntries = entries.filter((e: any) => e.type !== "session");
  if (sessionEntries.length === 0) return "[recall: session has no entries]";

  let ctx: any;
  try { ctx = buildSessionContext(sessionEntries); }
  catch (err: any) { return `[recall: failed to build context — ${err.message?.slice(0, 200)}]`; }

  if (!ctx.messages.length) return "[recall: session has no messages]";

  let temporalCtx = "";
  if (options.context) {
    const ts = extractTimestamp(sessionFile);
    if (ts) temporalCtx = loadTemporalContext(ts);
  }

  const systemPrompt = RECALL_SYSTEM + temporalCtx;
  const q = question + "\n\nRespond in plain text. Do not call any tools.";

  return apiCallStream([...ctx.messages, userMessage(q)], systemPrompt, modelSpec, options.onChunk);
}

function recallSession(ref: string, question: string, modelSpec: string, options: { context?: boolean; onChunk?: OnChunk } = {}) {
  // Direct .jsonl path
  if (ref.endsWith(".jsonl")) {
    if (!existsSync(ref)) return `[recall: file not found — ${ref}]`;
    return recallPiSession(ref, question, modelSpec, options);
  }

  // UUID lookup
  const session = findSession(ref);
  if (!session) return `[recall: session not found — ${ref}]`;

  return recallPiSession(session.path, question, modelSpec, options);
}

// ============================================================================
// DAY RECALL — load all episodes as context
// ============================================================================

function buildSessionIndex() {
  const index = new Map<string, string>();
  (function walk(dir: string) {
    try {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isDirectory()) { walk(p); continue; }
        if (!d.name.endsWith(".jsonl")) continue;
        const m = d.name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-\d{2}-\d{3}Z_(.+)\.jsonl$/);
        if (m) index.set(m[4], `${m[1]} ${m[2]}:${m[3]}`);
      }
    } catch {}
  })(PI_SESSIONS_DIR);
  return index;
}

function loadEpisodes(dateStr: string) {
  const dir = join(EPISODES_DIR, dateStr);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith(".md"));
  if (!files.length) return [];

  const sessionIndex = buildSessionIndex();
  const episodes: Array<{ sessionId: string; sortKey: string; content: string }> = [];

  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf8").trim();
    const sessionId = file.replace(".md", "");
    let sortKey = sessionIndex.get(sessionId);
    if (!sortKey) {
      const headerMatch = content.match(/<!--\s*session:\s*\S+\s*\|\s*(\d{4}-\d{2}-\d{2})\s+\d{2}:\d{2}(?:→(\d{2}:\d{2}))?\s*\|/);
      sortKey = headerMatch ? `${headerMatch[1]} ${headerMatch[2] || "00:00"}` : `${dateStr} 00:00`;
    }
    episodes.push({ sessionId, sortKey, content });
  }

  episodes.sort((a, b) => a.sortKey.localeCompare(b.sortKey));
  return episodes;
}

function recallDay(dateStr: string, question: string, modelSpec: string, onChunk?: OnChunk) {
  const episodes = loadEpisodes(dateStr);
  if (episodes.length === 0) return `[recall: no episodes found for ${dateStr}]`;

  const context = episodes.map((ep, i) =>
    `--- Episode ${i + 1}/${episodes.length} (session ${ep.sessionId}) ---\n${ep.content}`
  ).join("\n\n");

  const systemPrompt = `You are a recall agent for ${dateStr}. Your context is episode summaries from every session that day, in chronological order. Each episode covers one conversation session.

Be precise — use session IDs, times, exact details. When referencing a specific session, name it so the caller can drill into raw session context for verbatim detail. If your context doesn't contain enough detail, say which session(s) likely have the answer.`;

  const messages = [userMessage(`Question: ${question}\n\n---\n\nContext (episode summaries for ${dateStr}):\n\n${context}`)];
  return apiCallStream(messages, systemPrompt, modelSpec, onChunk);
}

// ============================================================================
// WEEK RECALL — load day summaries as context
// ============================================================================

function weekDates(weekStr: string) {
  const [yearStr, weekNum] = weekStr.split("-W");
  const year = parseInt(yearStr);
  const week = parseInt(weekNum);
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
  const dates: string[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

async function recallWeek(weekStr: string, question: string, modelSpec: string, onChunk?: OnChunk) {
  const dates = weekDates(weekStr);
  const daySummaries: Array<{ date: string; episodeCount: number; summary: string }> = [];

  for (const dateStr of dates) {
    const episodes = loadEpisodes(dateStr);
    if (episodes.length === 0) continue;

    const cachePath = join(CACHE_DIR, "days", `${dateStr}.md`);
    let summary: string;

    if (existsSync(cachePath)) {
      summary = readFileSync(cachePath, "utf8").trim();
    } else {
      summary = await recallDay(dateStr, "Write the narrative of this day. Not a checklist — an account of what happened, what was worked on, what got decided, what changed, and why. Track commitments made for today but don't carry weekly or longer-term goals — mention them naturally so higher temporal levels can pick them up. Include session IDs so any thread can be traced back to its source session.", modelSpec) as string;
      mkdirSync(join(CACHE_DIR, "days"), { recursive: true });
      writeFileSync(cachePath, summary);
    }

    daySummaries.push({ date: dateStr, episodeCount: episodes.length, summary });
  }

  if (daySummaries.length === 0) return `[recall: no data found for ${weekStr}]`;

  const context = daySummaries.map(d =>
    `--- ${d.date} (${d.episodeCount} episodes) ---\n${d.summary}`
  ).join("\n\n");

  const systemPrompt = `You are a recall agent for week ${weekStr}. Your context is day-level summaries for each day that had activity. Each summary covers all sessions from that day.

You operate at week resolution — individual session details live one level down in day summaries, verbatim detail lives two levels down in raw sessions. Name specific days or sessions when referencing detail so the caller can drill deeper. If your context doesn't contain enough detail, say which day likely has the answer.`;

  const messages = [userMessage(`Question: ${question}\n\n---\n\nContext (day summaries for ${weekStr}):\n\n${context}`)];
  return apiCallStream(messages, systemPrompt, modelSpec, onChunk);
}

// ============================================================================
// MONTH RECALL — load week summaries as context
// ============================================================================

function monthWeeks(monthStr: string) {
  const [year, month] = monthStr.split("-").map(Number);
  const lastDay = new Date(year, month, 0);

  const weeks = new Set<string>();
  const d = new Date(year, month - 1, 1);
  while (d <= lastDay) {
    const dayOfYear = Math.floor(((d as any) - (new Date(d.getFullYear(), 0, 1) as any)) / 86400000) + 1;
    const dow = d.getDay() || 7;
    const wn = Math.floor((dayOfYear - dow + 10) / 7);
    let wy = d.getFullYear();
    if (wn < 1) { wy--; weeks.add(`${wy}-W52`); }
    else if (wn > 52) {
      const dec31 = new Date(wy, 11, 31);
      const dec31dow = dec31.getDay() || 7;
      const maxWeek = dec31dow >= 4 ? 53 : 52;
      if (wn > maxWeek) { wy++; weeks.add(`${wy}-W01`); }
      else weeks.add(`${wy}-W${String(wn).padStart(2, "0")}`);
    }
    else weeks.add(`${wy}-W${String(wn).padStart(2, "0")}`);
    d.setDate(d.getDate() + 1);
  }
  return [...weeks].sort();
}

function weekHasData(weekStr: string) {
  const dates = weekDates(weekStr);
  return dates.some(d => loadEpisodes(d).length > 0);
}

async function recallMonth(monthStr: string, question: string, modelSpec: string, onChunk?: OnChunk) {
  const weeks = monthWeeks(monthStr);
  const weekSummaries: Array<{ week: string; activeDays: number; summary: string }> = [];

  for (const weekStr of weeks) {
    if (!weekHasData(weekStr)) continue;

    const cachePath = join(CACHE_DIR, "weeks", `${weekStr}.md`);
    let summary: string;

    if (existsSync(cachePath)) {
      summary = readFileSync(cachePath, "utf8").trim();
    } else {
      summary = await recallWeek(weekStr, "Write the narrative of this week. Not a checklist — an essay that identifies the main threads, arc, and trajectory. What's developing across multiple days? What started, what stalled, what shifted? Operate at week resolution — don't repeat daily details, surface the patterns that are only visible across days. Reference specific dates so the reader can drill down.", modelSpec) as string;
      mkdirSync(join(CACHE_DIR, "weeks"), { recursive: true });
      writeFileSync(cachePath, summary);
    }

    const dates = weekDates(weekStr);
    const activeDays = dates.filter(d => loadEpisodes(d).length > 0).length;
    weekSummaries.push({ week: weekStr, activeDays, summary });
  }

  if (weekSummaries.length === 0) return `[recall: no data found for ${monthStr}]`;

  const context = weekSummaries.map(w =>
    `--- ${w.week} (${w.activeDays} active days) ---\n${w.summary}`
  ).join("\n\n");

  const systemPrompt = `You are a recall agent for ${monthStr}. Your context is week-level summaries for each week that had activity.

You operate at month resolution — daily detail lives one level down in week summaries, session detail lives two levels down. Name specific weeks or days when referencing detail so the caller can drill deeper. If your context doesn't contain enough detail, say which week likely has the answer.`;

  const messages = [userMessage(`Question: ${question}\n\n---\n\nContext (week summaries for ${monthStr}):\n\n${context}`)];
  return apiCallStream(messages, systemPrompt, modelSpec, onChunk);
}

// ============================================================================
// QUARTER RECALL — load month summaries as context
// ============================================================================

function quarterMonths(quarterStr: string) {
  const [yearStr, qStr] = quarterStr.split("-Q");
  const q = parseInt(qStr);
  const startMonth = (q - 1) * 3 + 1;
  return [0, 1, 2].map(i => `${yearStr}-${String(startMonth + i).padStart(2, "0")}`);
}

function monthHasData(monthStr: string) {
  const weeks = monthWeeks(monthStr);
  return weeks.some(w => weekHasData(w));
}

async function recallQuarter(quarterStr: string, question: string, modelSpec: string, onChunk?: OnChunk) {
  const months = quarterMonths(quarterStr);
  const monthSummaries: Array<{ month: string; summary: string }> = [];

  for (const monthStr of months) {
    if (!monthHasData(monthStr)) continue;

    const cachePath = join(CACHE_DIR, "months", `${monthStr}.md`);
    let summary: string;

    if (existsSync(cachePath)) {
      summary = readFileSync(cachePath, "utf8").trim();
    } else {
      summary = await recallMonth(monthStr, "Write the narrative of this month. Identify the trajectory — what emerged, what shifted, what's building. Cover key decisions, what shipped, and the personal arc. Operate at month resolution — don't repeat weekly details, surface what's visible across weeks. Reference specific weeks so the reader can drill down.", modelSpec) as string;
      mkdirSync(join(CACHE_DIR, "months"), { recursive: true });
      writeFileSync(cachePath, summary);
    }

    monthSummaries.push({ month: monthStr, summary });
  }

  if (monthSummaries.length === 0) return `[recall: no data found for ${quarterStr}]`;

  const context = monthSummaries.map(m =>
    `--- ${m.month} ---\n${m.summary}`
  ).join("\n\n");

  const systemPrompt = `You are a recall agent for ${quarterStr}. Your context is month-level summaries for each month that had activity.

You operate at the highest temporal resolution available. Patterns, trajectories, and emergent themes visible here are invisible at lower levels. Month-level detail lives one level down, week and day detail two and three levels down. Name specific months, weeks, or days when referencing detail so the caller can drill deeper. If your context doesn't contain enough detail, say which month likely has the answer.`;

  const messages = [userMessage(`Question: ${question}\n\n---\n\nContext (month summaries for ${quarterStr}):\n\n${context}`)];
  const result = await apiCallStream(messages, systemPrompt, modelSpec, onChunk);

  const cachePath = join(CACHE_DIR, "quarters", `${quarterStr}.md`);
  if (!existsSync(cachePath) && result && !result.startsWith("[recall:")) {
    mkdirSync(join(CACHE_DIR, "quarters"), { recursive: true });
    writeFileSync(cachePath, result as string);
  }

  return result;
}

// ============================================================================
// YEAR RECALL — load quarter summaries as context
// ============================================================================

function yearQuarters(yearStr: string) {
  return [1, 2, 3, 4].map(q => `${yearStr}-Q${q}`);
}

function quarterHasData(quarterStr: string) {
  const months = quarterMonths(quarterStr);
  return months.some(m => monthHasData(m));
}

async function recallYear(yearStr: string, question: string, modelSpec: string, onChunk?: OnChunk) {
  const quarters = yearQuarters(yearStr);
  const quarterSummaries: Array<{ quarter: string; summary: string }> = [];

  for (const quarterStr of quarters) {
    if (!quarterHasData(quarterStr)) continue;

    const cachePath = join(CACHE_DIR, "quarters", `${quarterStr}.md`);
    let summary: string;

    if (existsSync(cachePath)) {
      summary = readFileSync(cachePath, "utf8").trim();
    } else {
      summary = await recallQuarter(quarterStr, "Write a narrative of this quarter. What's the arc — what materialized that wasn't there at the start, what's building? Don't restate monthly details — just what's visible from this altitude. Reference specific months so the reader can drill down.", modelSpec) as string;
      mkdirSync(join(CACHE_DIR, "quarters"), { recursive: true });
      writeFileSync(cachePath, summary);
    }

    quarterSummaries.push({ quarter: quarterStr, summary });
  }

  if (quarterSummaries.length === 0) return `[recall: no data found for ${yearStr}]`;

  const context = quarterSummaries.map(q =>
    `--- ${q.quarter} ---\n${q.summary}`
  ).join("\n\n");

  const systemPrompt = `You are a recall agent for ${yearStr}. Your context is quarter-level summaries for each quarter that had activity.

You operate at the highest temporal resolution available — the full year. Arcs, transformations, and emergent themes visible here are invisible at any lower level. Quarter-level detail lives one level down, month and week detail two and three levels down. Name specific quarters, months, or weeks when referencing detail so the caller can drill deeper. If your context doesn't contain enough detail, say which quarter likely has the answer.`;

  const messages = [userMessage(`Question: ${question}\n\n---\n\nContext (quarter summaries for ${yearStr}):\n\n${context}`)];
  const result = await apiCallStream(messages, systemPrompt, modelSpec, onChunk);

  const cachePath = join(CACHE_DIR, "years", `${yearStr}.md`);
  if (!existsSync(cachePath) && result && !result.startsWith("[recall:")) {
    mkdirSync(join(CACHE_DIR, "years"), { recursive: true });
    writeFileSync(cachePath, result as string);
  }

  return result;
}

// ============================================================================
// API CALL — routes through unified complete()/stream()
// ============================================================================

type OnChunk = (accumulated: string) => void;

async function apiCall(messages: any[], systemPrompt: string, modelSpec: string) {
  const result = await complete(messages, systemPrompt, modelSpec);

  if (result.stopReason === "error") {
    const errMsg = result.errorMessage || "unknown API error";
    const match = errMsg.match(/"message":"([^"]+)"/);
    return `[recall: API error — ${match ? match[1] : errMsg.slice(0, 200)}]`;
  }

  return getText(result);
}

async function apiCallStream(messages: any[], systemPrompt: string, modelSpec: string, onChunk?: OnChunk) {
  if (!onChunk) return apiCall(messages, systemPrompt, modelSpec);

  const eventStream = aiStream(messages, systemPrompt, modelSpec);
  let accumulated = "";

  for await (const event of eventStream) {
    if (event.type === "text_delta") {
      accumulated += event.delta;
      onChunk(accumulated);
    }
  }

  return accumulated || "[recall: empty response from API]";
}

// ============================================================================
// PUBLIC API
// ============================================================================

export async function recall(ref: string, question: string, modelSpec = "opus", options: { context?: boolean; onChunk?: OnChunk } = {}) {
  const type = refType(ref);
  const { onChunk } = options;

  if (type === "day") return recallDay(ref, question, modelSpec, onChunk);
  if (type === "week") return recallWeek(ref, question, modelSpec, onChunk);
  if (type === "month") return recallMonth(ref, question, modelSpec, onChunk);
  if (type === "quarter") return recallQuarter(ref, question, modelSpec, onChunk);
  if (type === "year") return recallYear(ref, question, modelSpec, onChunk);

  // Session
  return recallSession(ref, question, modelSpec, { context: options.context, onChunk });
}

// Expose for episode daemon
export { loadEpisodes, weekDates, monthWeeks, quarterMonths, yearQuarters, weekHasData, monthHasData, quarterHasData };

// ============================================================================
// CLI
// ============================================================================

if (process.argv[1]?.includes("recall-engine") || process.argv[1]?.includes("recall")) {
  const args = process.argv.slice(2);

  let modelSpec = "opus";
  const modelIdx = args.indexOf("--model");
  if (modelIdx !== -1 && args[modelIdx + 1]) {
    modelSpec = args[modelIdx + 1];
    args.splice(modelIdx, 2);
  }

  let context = false;
  const contextIdx = args.indexOf("--context");
  if (contextIdx !== -1) {
    context = true;
    args.splice(contextIdx, 1);
  }

  if (args.length < 2) {
    console.error("Usage: recall [--model <model>] [--context] <ref> \"question\"");
    console.error("  ref: session UUID, .jsonl path, YYYY-MM-DD (day), YYYY-Www (week), YYYY-MM (month), YYYY-QN (quarter), YYYY (year)");
    console.error("  models: haiku, sonnet, opus (default)");
    console.error("  --context: load temporal context from when the session ran (situated witness)");
    process.exit(1);
  }

  const ref = args[0];
  const question = args.slice(1).join(" ");

  try {
    const answer = await recall(ref, question, modelSpec, { context });
    console.log(answer);
  } catch (err: any) {
    console.error(`recall failed: ${err.message}`);
    process.exit(1);
  }
}
