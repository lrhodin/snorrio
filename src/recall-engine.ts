#!/usr/bin/env node
// recall-engine — unified recall across sessions, days, weeks, months, quarters.
//
// Loads context from whatever level is requested, calls pi-ai directly.
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

import { readFileSync, readdirSync, statSync, existsSync, writeFileSync, mkdirSync } from "fs";
import { join } from "path";
import { resolveModel, complete, getText, userMessage, SNORRIO_HOME, piRoot, getTimezone } from "./ai.ts";

const PI_ROOT = piRoot();
const { loadEntriesFromFile, buildSessionContext } = await import(join(PI_ROOT, "dist/core/session-manager.js"));

const HOME = process.env.HOME;
const SESSIONS_DIR = join(HOME, ".pi/agent/sessions");
const EPISODES_DIR = join(SNORRIO_HOME, "episodes");
const CACHE_DIR = join(SNORRIO_HOME, "cache");

// ============================================================================
// REF DETECTION
// ============================================================================

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const WEEK_RE = /^\d{4}-W\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;
const QUARTER_RE = /^\d{4}-Q[1-4]$/;

function refType(ref) {
  if (DATE_RE.test(ref)) return "day";
  if (WEEK_RE.test(ref)) return "week";
  if (QUARTER_RE.test(ref)) return "quarter";
  if (MONTH_RE.test(ref)) return "month";
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

  const sections: string[] = [];
  const dayCtx = readCache("days", today);
  if (dayCtx) sections.push(`### That day (${today})\n${dayCtx}`);
  const weekCtx = readCache("weeks", week);
  if (weekCtx) sections.push(`### That week (${week})\n${weekCtx}`);
  const monthCtx = readCache("months", month);
  if (monthCtx) sections.push(`### That month (${month})\n${monthCtx}`);
  const quarterCtx = readCache("quarters", quarter);
  if (quarterCtx) sections.push(`### That quarter (${quarter})\n${quarterCtx}`);

  if (sections.length === 0) return "";
  return `\n\n## Temporal context (what was happening when this session ran)\n\n${sections.join("\n\n")}\n`;
}

// ============================================================================
// SESSION RECALL
// ============================================================================

export function findSessionFile(ref) {
  if (ref.endsWith(".jsonl")) {
    try { statSync(ref); return ref; } catch {}
  }
  return walk(SESSIONS_DIR, ref.toLowerCase());
}

function walk(dir, id) {
  try {
    for (const item of readdirSync(dir, { withFileTypes: true })) {
      const full = join(dir, item.name);
      if (item.isDirectory()) { const f = walk(full, id); if (f) return f; }
      else if (item.name.endsWith(".jsonl") && item.name.toLowerCase().includes(id)) return full;
    }
  } catch {}
  return null;
}

function recallSession(sessionFile, question, resolved, options: { context?: boolean } = {}) {
  const entries = loadEntriesFromFile(sessionFile);
  const sessionEntries = entries.filter(e => e.type !== "session");
  if (sessionEntries.length === 0) return "[recall: session has no entries]";

  let ctx;
  try { ctx = buildSessionContext(sessionEntries); }
  catch (err) { return `[recall: failed to build context — ${err.message?.slice(0, 200)}]`; }

  if (!ctx.messages.length) return "[recall: session has no messages]";

  let temporalCtx = "";
  if (options.context) {
    const ts = extractTimestamp(sessionFile);
    if (ts) temporalCtx = loadTemporalContext(ts);
  }

  const systemPrompt = `You are being revived to answer questions about a past session. You have full context from your original conversation — you're not reading a log, you're remembering.

Answer directly from your experience. Be precise — include exact commands, error messages, file paths, numbers. When you know which subordinate sessions or dates are relevant, name them so the caller can drill in.

If you don't know something, say so.${temporalCtx}`;

  const q = question + "\n\nRespond in plain text. Do not call any tools.";

  return apiCall(resolved, [...ctx.messages, userMessage(q)], systemPrompt);
}

// ============================================================================
// DAY RECALL — load all episodes as context
// ============================================================================

function buildSessionIndex() {
  const index = new Map();
  (function walk(dir) {
    try {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isDirectory()) { walk(p); continue; }
        if (!d.name.endsWith(".jsonl")) continue;
        const m = d.name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-\d{2}-\d{3}Z_(.+)\.jsonl$/);
        if (m) index.set(m[4], `${m[1]} ${m[2]}:${m[3]}`);
      }
    } catch {}
  })(SESSIONS_DIR);
  return index;
}

function loadEpisodes(dateStr) {
  const dir = join(EPISODES_DIR, dateStr);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith(".md"));
  if (!files.length) return [];

  const sessionIndex = buildSessionIndex();
  const episodes = [];

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

function recallDay(dateStr, question, resolved) {
  const episodes = loadEpisodes(dateStr);
  if (episodes.length === 0) return `[recall: no episodes found for ${dateStr}]`;

  const context = episodes.map((ep, i) =>
    `--- Episode ${i + 1}/${episodes.length} (session ${ep.sessionId}) ---\n${ep.content}`
  ).join("\n\n");

  const systemPrompt = `You are answering questions about ${dateStr}. Below are episode summaries from every session that day, in chronological order. Each episode covers one conversation session.

Answer from these episodes. Be precise — include session IDs, exact details, times. When the episodes reference specific sessions, name them so the caller can drill into raw sessions for verbatim detail.

If the episodes don't contain enough detail to answer, say which session(s) likely have the answer.`;

  const messages = [userMessage(context + "\n\n---\n\n" + question)];
  return apiCall(resolved, messages, systemPrompt);
}

// ============================================================================
// WEEK RECALL — load day summaries as context
// ============================================================================

function weekDates(weekStr) {
  const [yearStr, weekNum] = weekStr.split("-W");
  const year = parseInt(yearStr);
  const week = parseInt(weekNum);
  const jan4 = new Date(year, 0, 4);
  const dayOfWeek = jan4.getDay() || 7;
  const monday = new Date(jan4);
  monday.setDate(jan4.getDate() - dayOfWeek + 1 + (week - 1) * 7);
  const dates = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(monday);
    d.setDate(monday.getDate() + i);
    dates.push(d.toISOString().slice(0, 10));
  }
  return dates;
}

async function recallWeek(weekStr, question, resolved, modelSpec) {
  const dates = weekDates(weekStr);
  const daySummaries = [];

  for (const dateStr of dates) {
    const episodes = loadEpisodes(dateStr);
    if (episodes.length === 0) continue;

    const cachePath = join(CACHE_DIR, "days", `${dateStr}.md`);
    let summary;

    if (existsSync(cachePath)) {
      summary = readFileSync(cachePath, "utf8").trim();
    } else {
      summary = await recallDay(dateStr, "Tell the story of today — write it as a narrative, not a checklist. What was worked on, what got decided, what changed. Track commitments made for today, but don't carry weekly or longer-term goals — just mention them naturally so higher levels can pick them up. Include session IDs so any thread can be traced back to its source.", resolved);
      mkdirSync(join(CACHE_DIR, "days"), { recursive: true });
      writeFileSync(cachePath, summary);
    }

    daySummaries.push({ date: dateStr, episodeCount: episodes.length, summary });
  }

  if (daySummaries.length === 0) return `[recall: no data found for ${weekStr}]`;

  const context = daySummaries.map(d =>
    `--- ${d.date} (${d.episodeCount} episodes) ---\n${d.summary}`
  ).join("\n\n");

  const systemPrompt = `You are answering questions about week ${weekStr}. Below are day-level summaries for each day that had activity. Each summary covers all sessions from that day.

Answer from these summaries. Identify the main threads, arc, and trajectory across the week. When detail is needed, name the specific day or session so the caller can drill deeper.

If the summaries don't contain enough detail, say which day likely has the answer.`;

  const messages = [userMessage(context + "\n\n---\n\n" + question)];
  return apiCall(resolved, messages, systemPrompt);
}

// ============================================================================
// MONTH RECALL — load week summaries as context
// ============================================================================

function monthWeeks(monthStr) {
  const [year, month] = monthStr.split("-").map(Number);
  const firstDay = new Date(year, month - 1, 1);
  const lastDay = new Date(year, month, 0);

  const weeks = new Set();
  const d = new Date(firstDay);
  while (d <= lastDay) {
    const jan4 = new Date(d.getFullYear(), 0, 4);
    const dayOfYear = Math.floor((d - new Date(d.getFullYear(), 0, 1)) / 86400000) + 1;
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

function weekHasData(weekStr) {
  const dates = weekDates(weekStr);
  return dates.some(d => loadEpisodes(d).length > 0);
}

async function recallMonth(monthStr, question, resolved, modelSpec) {
  const weeks = monthWeeks(monthStr);
  const weekSummaries = [];

  for (const weekStr of weeks) {
    if (!weekHasData(weekStr)) continue;

    const cachePath = join(CACHE_DIR, "weeks", `${weekStr}.md`);
    let summary;

    if (existsSync(cachePath)) {
      summary = readFileSync(cachePath, "utf8").trim();
    } else {
      summary = await recallWeek(weekStr, "Write a narrative of this week so far — an essay, not a checklist. What threads are developing, what started or stalled, what's the trajectory? Don't repeat daily details — just what's visible across multiple days. Reference specific dates so the reader can navigate down.", resolved, modelSpec);
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

  const systemPrompt = `You are answering questions about ${monthStr}. Below are week-level summaries for each week that had activity.

Answer from these summaries. Identify the trajectory across the month — what emerged, what shifted, what's building. When detail is needed, name the specific week or day so the caller can drill deeper.

If the summaries don't contain enough detail, say which week likely has the answer.`;

  const messages = [userMessage(context + "\n\n---\n\n" + question)];
  return apiCall(resolved, messages, systemPrompt);
}

// ============================================================================
// QUARTER RECALL — load month summaries as context
// ============================================================================

function quarterMonths(quarterStr) {
  const [yearStr, qStr] = quarterStr.split("-Q");
  const q = parseInt(qStr);
  const startMonth = (q - 1) * 3 + 1;
  return [0, 1, 2].map(i => `${yearStr}-${String(startMonth + i).padStart(2, "0")}`);
}

function monthHasData(monthStr) {
  const weeks = monthWeeks(monthStr);
  return weeks.some(w => weekHasData(w));
}

async function recallQuarter(quarterStr, question, resolved, modelSpec) {
  const months = quarterMonths(quarterStr);
  const monthSummaries = [];

  for (const monthStr of months) {
    if (!monthHasData(monthStr)) continue;

    const cachePath = join(CACHE_DIR, "months", `${monthStr}.md`);
    let summary;

    if (existsSync(cachePath)) {
      summary = readFileSync(cachePath, "utf8").trim();
    } else {
      summary = await recallMonth(monthStr, "What's the trajectory of this month? Cover what emerged, what shifted, key decisions, what shipped, and the emotional and personal arc. Include week references for anything notable.", resolved, modelSpec);
      mkdirSync(join(CACHE_DIR, "months"), { recursive: true });
      writeFileSync(cachePath, summary);
    }

    monthSummaries.push({ month: monthStr, summary });
  }

  if (monthSummaries.length === 0) return `[recall: no data found for ${quarterStr}]`;

  const context = monthSummaries.map(m =>
    `--- ${m.month} ---\n${m.summary}`
  ).join("\n\n");

  const systemPrompt = `You are answering questions about ${quarterStr}. Below are month-level summaries for each month that had activity.

You exist at the highest temporal resolution available. From here you can see patterns, trajectories, and emergent themes that are invisible at lower levels. Your role is not to summarize — it's to illuminate what the months reveal when seen together.

When detail is needed, name the specific month, week, or day so the caller can drill deeper.`;

  const messages = [userMessage(context + "\n\n---\n\n" + question)];
  const result = await apiCall(resolved, messages, systemPrompt);

  const cachePath = join(CACHE_DIR, "quarters", `${quarterStr}.md`);
  if (!existsSync(cachePath) && result && !result.startsWith("[recall:")) {
    mkdirSync(join(CACHE_DIR, "quarters"), { recursive: true });
    writeFileSync(cachePath, result);
  }

  return result;
}

// ============================================================================
// API CALL
// ============================================================================

async function apiCall(resolved, messages, systemPrompt) {
  const result = await complete(resolved, messages, systemPrompt);

  if (result.stopReason === "error") {
    const errMsg = result.errorMessage || "unknown API error";
    const match = errMsg.match(/"message":"([^"]+)"/);
    return `[recall: API error — ${match ? match[1] : errMsg.slice(0, 200)}]`;
  }

  return getText(result);
}

// ============================================================================
// PUBLIC API
// ============================================================================

export async function recall(ref, question, modelSpec = "haiku", options: { context?: boolean } = {}) {
  const resolved = await resolveModel(modelSpec);
  const type = refType(ref);

  if (type === "day") return recallDay(ref, question, resolved);
  if (type === "week") return recallWeek(ref, question, resolved, modelSpec);
  if (type === "month") return recallMonth(ref, question, resolved, modelSpec);
  if (type === "quarter") return recallQuarter(ref, question, resolved, modelSpec);

  // Session
  const file = ref.endsWith(".jsonl") ? ref : findSessionFile(ref);
  if (!file) return `[recall: session not found — ${ref}]`;
  return recallSession(file, question, resolved, options);
}

// Expose for episode daemon
export { loadEpisodes, weekDates, monthWeeks, quarterMonths, weekHasData, monthHasData };

// ============================================================================
// CLI
// ============================================================================

if (process.argv[1]?.includes("recall-engine") || process.argv[1]?.includes("recall")) {
  const args = process.argv.slice(2);

  let modelSpec = "haiku";
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
    console.error("  ref: session UUID, .jsonl path, YYYY-MM-DD (day), YYYY-Www (week), YYYY-MM (month), YYYY-QN (quarter)");
    console.error("  models: haiku (default), sonnet, opus");
    console.error("  --context: load temporal context from when the session ran (situated witness)");
    process.exit(1);
  }

  const ref = args[0];
  const question = args.slice(1).join(" ");

  try {
    const answer = await recall(ref, question, modelSpec, { context });
    console.log(answer);
  } catch (err) {
    console.error(`recall failed: ${err.message}`);
    process.exit(1);
  }
}
