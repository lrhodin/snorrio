#!/usr/bin/env node
// Episode pipeline daemon.
//
// Watches session files. After 4:30 of inactivity on a file, generates an
// episode via direct LLM call. Midnight sweep catches anything missed.
//
// No manifest. No state tracking. Idempotent — episodes overwrite freely.
// No minimum message threshold — every session with an assistant message
// gets an episode.
//
// Cache lifecycle:
//   New episode → regenerate day + week caches (atomic write)
//   Day locks (first episode of new day) → regenerate month cache
//   Week locks (first episode of new week) → regenerate quarter cache
//   Month locks (first episode of new month) → regenerate year cache
//   All writes are atomic (tmp + rename). No gap where cache is missing.
//
// Data:
//   $SNORRIO_HOME/episodes/YYYY-MM-DD/<session-id>.md
//   $SNORRIO_HOME/cache/{days,weeks,months,quarters}/
//
// Usage:
//   node episode-daemon.ts            — live daemon
//   node episode-daemon.ts --sweep    — one-shot: generate missing episodes
//   node episode-daemon.ts --reprocess — one-shot: regenerate ALL episodes

import { watch } from "fs";
import {
  readFileSync, writeFileSync, mkdirSync, existsSync,
  readdirSync, unlinkSync, renameSync, appendFileSync,
} from "fs";
import { join, basename } from "path";
import { hostname as osHostname } from "os";
import { resolveModel, complete, getText, userMessage, SNORRIO_HOME, piRoot, getTimezone } from "./ai.ts";
import { recall } from "./recall-engine.ts";

const PI_ROOT = piRoot();
const { loadEntriesFromFile, buildSessionContext } = await import(
  join(PI_ROOT, "dist/core/session-manager.js")
);

const HOME = process.env.HOME;
const SESSIONS_DIR = join(HOME, ".pi/agent/sessions");
const EPISODES_DIR = join(SNORRIO_HOME, "episodes");
const CACHE_DIR = join(SNORRIO_HOME, "cache");

const DEBOUNCE_MS = 270_000; // 4 minutes 30 seconds
const TZ = getTimezone();

function getMachine() {
  try {
    const cfg = JSON.parse(readFileSync(join(HOME, ".config/snorrio/config.json"), "utf8"));
    if (cfg.machine) return cfg.machine;
  } catch {}
  return osHostname().replace(/\.local$/, "").toLowerCase();
}
const MACHINE = getMachine();

function buildFrontmatter(origin, sourcePath, timestamp) {
  const source = sourcePath.startsWith(HOME) ? "~" + sourcePath.slice(HOME.length) : sourcePath;
  return `---\norigin: ${origin}\nmachine: ${MACHINE}\nsource: ${source}\ntimestamp: ${timestamp}\n---\n\n`;
}

const timers = new Map();
const inflight = new Set();

let lastProcessedDate = null;
let lastProcessedWeek = null;
let lastProcessedMonth = null;

const LOG_DIR = join(SNORRIO_HOME, "logs");
mkdirSync(LOG_DIR, { recursive: true });
function log(msg) {
  const line = `[DMN] ${new Date().toISOString()} ${msg}\n`;
  process.stderr.write(line);
  try {
    const today = new Date().toISOString().slice(0, 10);
    appendFileSync(join(LOG_DIR, `${today}.log`), line);
  } catch {}
}

// ============================================================================
// SESSION HELPERS
// ============================================================================

function toDateStr(iso) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

function parseSession(filePath) {
  const raw = readFileSync(filePath, "utf8");
  const entries = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries;
}

function sessionId(entries) {
  return entries.find(e => e.type === "session")?.id || null;
}

function sessionTimestamps(entries) {
  const ts = entries.map(e => e.timestamp).filter(Boolean)
    .map(t => new Date(t).getTime()).filter(t => !isNaN(t));
  if (!ts.length) return { start: null, end: null };
  return {
    start: new Date(Math.min(...ts)).toISOString(),
    end: new Date(Math.max(...ts)).toISOString(),
  };
}

function hasAssistantMessage(entries) {
  return entries.some(e => e.type === "message" && e.message?.role === "assistant");
}

// ============================================================================
// EPISODE GENERATION
// ============================================================================

const EPISODE_SYSTEM = `You write journal entries from coding agent sessions. An entry captures both what was done and what was discussed — the actions, the reasoning, the intent behind them. Include concrete details where they matter: files changed, commands run, decisions made. But equally capture the conversation: what ideas came up, what got debated, what the human cared about, what the tone and energy was. Note session IDs of related sessions when referenced.`;

async function generateEpisode(filePath) {
  const entries = parseSession(filePath);
  const id = sessionId(entries);
  if (!id) { log(`  No session ID: ${basename(filePath)}`); return null; }

  if (!hasAssistantMessage(entries)) return null;

  const sessionEntries = entries.filter(e => e.type !== "session");
  let ctx;
  try {
    ctx = buildSessionContext(sessionEntries);
  } catch (err) {
    log(`  Context failed ${id.slice(0, 8)}: ${err.message?.slice(0, 200)}`);
    return null;
  }
  if (!ctx.messages.length) { log(`  Empty context: ${id.slice(0, 8)}`); return null; }

  const { start, end } = sessionTimestamps(entries);
  const dateStr = toDateStr(end || start || new Date().toISOString());

  log(`  Generating: ${id.slice(0, 8)} (${dateStr})`);

  const resolved = await resolveModel(null, "dmn");
  const messages = [
    ...ctx.messages,
    userMessage("Write a journal entry for this session.\n\nRespond in plain text. Do not call any tools."),
  ];

  const result = await complete(resolved, messages, EPISODE_SYSTEM);
  if (result.stopReason === "error") {
    log(`  API error ${id.slice(0, 8)}: ${(result.errorMessage || "").slice(0, 200)}`);
    return null;
  }

  const text = getText(result);
  if (!text) { log(`  Empty output: ${id.slice(0, 8)}`); return null; }

  const fm = buildFrontmatter("pi", filePath, end || start || new Date().toISOString());
  const dir = join(EPISODES_DIR, dateStr);
  mkdirSync(dir, { recursive: true });
  const epPath = join(dir, `${id}.md`);
  const tmp = epPath + ".tmp";
  writeFileSync(tmp, fm + text, "utf8");
  renameSync(tmp, epPath);

  log(`  Done: ${id.slice(0, 8)} → ${text.length} chars`);

  if (!globalThis._skipCascade) {
    await cascadeForDate(dateStr);
  }

  return { id, dateStr, path: epPath };
}

// ============================================================================
// TEMPORAL HELPERS
// ============================================================================

function dateToWeek(dateStr) {
  const dt = new Date(dateStr + "T12:00:00Z");
  const dayOfYear = Math.floor((dt - new Date(dt.getFullYear(), 0, 1)) / 86400000) + 1;
  const dow = dt.getDay() || 7;
  const wn = Math.floor((dayOfYear - dow + 10) / 7);
  let wy = dt.getFullYear();
  if (wn < 1) wy--;
  else if (wn > 52) {
    const dec31 = new Date(wy, 11, 31);
    const maxWeek = ((dec31.getDay() || 7) >= 4) ? 53 : 52;
    if (wn > maxWeek) wy++;
  }
  return `${wy}-W${String(Math.max(1, wn)).padStart(2, "0")}`;
}

function monthToQuarter(monthStr) {
  const [year, month] = monthStr.split("-").map(Number);
  return `${year}-Q${Math.ceil(month / 3)}`;
}

function atomicWrite(filePath, content) {
  const dir = join(filePath, "..");
  mkdirSync(dir, { recursive: true });
  const tmp = filePath + ".tmp";
  writeFileSync(tmp, content, "utf8");
  renameSync(tmp, filePath);
}

const CACHE_Q_DAY = "Tell the story of today — write it as a narrative, not a checklist. What was worked on, what got decided, what changed. Track commitments made for today, but don't carry weekly or longer-term goals — just mention them naturally so higher levels can pick them up. Include session IDs so any thread can be traced back to its source.";
const CACHE_Q_WEEK = "Write a narrative of this week so far — an essay, not a checklist. What threads are developing, what started or stalled, what's the trajectory? Don't repeat daily details — just what's visible across multiple days. You're the continuity layer across day boundaries — anything in flight that a new day needs to pick up should be here, with enough detail to find the right day. Reference specific dates so the reader can navigate down.";
const CACHE_Q_MONTH = "Write a narrative of this month so far — an essay, not a checklist. What shifted, what themes emerged or faded, what's shaping the direction? Don't restate weekly details — just what's visible at the monthly level. You're the continuity layer across week boundaries — any active threads a new week needs to carry forward should be here, with enough context to find the right week. Reference specific weeks so the reader can navigate down.";
const CACHE_Q_QUARTER = "Write a narrative of this quarter so far — an essay, not a checklist. What's the arc, what materialized that wasn't there at the start, what's building? Don't restate monthly details — just what's visible from this altitude. You're the continuity layer across month boundaries — any arcs a new month needs to carry forward should be here, with enough context to find the right month. Reference specific months so the reader can navigate down.";

async function cascadeForDate(dateStr) {
  const weekStr = dateToWeek(dateStr);
  const monthStr = dateStr.slice(0, 7);

  try {
    log(`  Regenerating day cache: ${dateStr}`);
    const daySummary = await recall(dateStr, CACHE_Q_DAY, "opus");
    if (daySummary && !daySummary.startsWith("[recall:")) {
      atomicWrite(join(CACHE_DIR, "days", `${dateStr}.md`), daySummary);
    }
  } catch (err) { log(`  Day cache error: ${err.message?.slice(0, 100)}`); }

  try {
    log(`  Regenerating week cache: ${weekStr}`);
    const weekSummary = await recall(weekStr, CACHE_Q_WEEK, "opus");
    if (weekSummary && !weekSummary.startsWith("[recall:")) {
      atomicWrite(join(CACHE_DIR, "weeks", `${weekStr}.md`), weekSummary);
    }
  } catch (err) { log(`  Week cache error: ${err.message?.slice(0, 100)}`); }

  if (lastProcessedDate && lastProcessedDate !== dateStr) {
    log(`  Day boundary → regenerating month cache: ${monthStr}`);
    try {
      const monthSummary = await recall(monthStr, CACHE_Q_MONTH, "opus");
      if (monthSummary && !monthSummary.startsWith("[recall:")) {
        atomicWrite(join(CACHE_DIR, "months", `${monthStr}.md`), monthSummary);
      }
    } catch (err) { log(`  Month cache error: ${err.message?.slice(0, 100)}`); }
  }

  if (lastProcessedWeek && lastProcessedWeek !== weekStr) {
    const quarterStr = monthToQuarter(monthStr);
    log(`  Week boundary → regenerating quarter cache: ${quarterStr}`);
    try {
      const quarterSummary = await recall(quarterStr, CACHE_Q_QUARTER, "opus");
      if (quarterSummary && !quarterSummary.startsWith("[recall:")) {
        atomicWrite(join(CACHE_DIR, "quarters", `${quarterStr}.md`), quarterSummary);
      }
    } catch (err) { log(`  Quarter cache error: ${err.message?.slice(0, 100)}`); }
  }

  lastProcessedDate = dateStr;
  lastProcessedWeek = weekStr;
  lastProcessedMonth = monthStr;
}

// ============================================================================
// WATCHER
// ============================================================================

function onSessionChange(filePath) {
  if (!filePath.endsWith(".jsonl")) return;
  if (timers.has(filePath)) clearTimeout(timers.get(filePath));
  timers.set(filePath, setTimeout(async () => {
    timers.delete(filePath);
    if (inflight.has(filePath)) return;
    inflight.add(filePath);
    log(`Debounce fired: ${basename(filePath).slice(0, 50)}`);
    try { await generateEpisode(filePath); }
    catch (err) { log(`Error: ${err.message}`); }
    finally { inflight.delete(filePath); }
  }, DEBOUNCE_MS));
}

function startWatcher() {
  log(`Watching ${SESSIONS_DIR}`);
  watch(SESSIONS_DIR, { recursive: true }, (_, filename) => {
    if (!filename?.endsWith(".jsonl")) return;
    onSessionChange(join(SESSIONS_DIR, filename));
  });
}

// ============================================================================
// SWEEP / REPROCESS
// ============================================================================

function allSessions() {
  const files = [];
  (function walk(dir) {
    try {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isDirectory()) walk(p);
        else if (d.name.endsWith(".jsonl")) files.push(p);
      }
    } catch {}
  })(SESSIONS_DIR);
  return files;
}

async function sweep() {
  log("Sweep starting...");
  globalThis._skipCascade = true;
  const files = allSessions();
  let count = 0, skip = 0;
  const CONCURRENCY = parseInt(process.env.REPROCESS_CONCURRENCY || "8");
  const touchedDays = new Set();

  const todo = [];
  for (const f of files) {
    const entries = parseSession(f);
    const id = sessionId(entries);
    if (!id || !hasAssistantMessage(entries)) continue;
    const { start, end } = sessionTimestamps(entries);
    const dateStr = toDateStr(end || start || new Date().toISOString());
    if (existsSync(join(EPISODES_DIR, dateStr, `${id}.md`))) { skip++; continue; }
    todo.push(f);
  }
  log(`  ${todo.length} sessions need episodes, ${skip} already exist (concurrency: ${CONCURRENCY})`);

  const pool = new Set();
  for (const f of todo) {
    if (pool.size >= CONCURRENCY) await Promise.race(pool);
    const p = (async () => {
      try {
        const r = await generateEpisode(f);
        if (r) { count++; touchedDays.add(r.dateStr); }
      } catch (err) {
        const entries = parseSession(f);
        const id = sessionId(entries);
        log(`Sweep error ${id?.slice(0, 8)}: ${err.message}`);
      }
    })().then(() => pool.delete(p));
    pool.add(p);
  }
  await Promise.all(pool);
  log(`  Episodes done: ${count} new, ${skip} skipped`);

  if (touchedDays.size === 0) { log("Sweep done: nothing new"); globalThis._skipCascade = false; return; }

  const days = [...touchedDays].sort();
  log(`  Rebuilding ${days.length} day caches (parallel)`);
  await Promise.all(days.map(async (d) => {
    try {
      const summary = await recall(d, CACHE_Q_DAY, "opus");
      if (summary && !summary.startsWith("[recall:")) atomicWrite(join(CACHE_DIR, "days", `${d}.md`), summary);
      log(`    ${d} ✓`);
    } catch (err) { log(`    ${d} ✗ ${err.message?.slice(0, 100)}`); }
  }));

  const weeks = [...new Set(days.map(d => dateToWeek(d)))].sort();
  log(`  Rebuilding ${weeks.length} week caches (parallel)`);
  await Promise.all(weeks.map(async (w) => {
    try {
      const summary = await recall(w, CACHE_Q_WEEK, "opus");
      if (summary && !summary.startsWith("[recall:")) atomicWrite(join(CACHE_DIR, "weeks", `${w}.md`), summary);
      log(`    ${w} ✓`);
    } catch (err) { log(`    ${w} ✗ ${err.message?.slice(0, 100)}`); }
  }));

  const months = [...new Set(days.map(d => d.slice(0, 7)))].sort();
  log(`  Rebuilding ${months.length} month caches (parallel)`);
  await Promise.all(months.map(async (m) => {
    try {
      const summary = await recall(m, CACHE_Q_MONTH, "opus");
      if (summary && !summary.startsWith("[recall:")) atomicWrite(join(CACHE_DIR, "months", `${m}.md`), summary);
      log(`    ${m} ✓`);
    } catch (err) { log(`    ${m} ✗ ${err.message?.slice(0, 100)}`); }
  }));

  const quarters = [...new Set(months.map(m => { const [y, mm] = m.split("-"); return `${y}-Q${Math.ceil(parseInt(mm) / 3)}`; }))].sort();
  log(`  Rebuilding ${quarters.length} quarter caches (parallel)`);
  await Promise.all(quarters.map(async (q) => {
    try {
      const summary = await recall(q, CACHE_Q_QUARTER, "opus");
      if (summary && !summary.startsWith("[recall:")) atomicWrite(join(CACHE_DIR, "quarters", `${q}.md`), summary);
      log(`    ${q} ✓`);
    } catch (err) { log(`    ${q} ✗ ${err.message?.slice(0, 100)}`); }
  }));

  globalThis._skipCascade = false;
  log(`Sweep done: ${count} episodes, ${days.length} days, ${weeks.length} weeks, ${months.length} months, ${quarters.length} quarters`);
}

// ============================================================================
// REPROCESS
// ============================================================================

const LEVELS = ["episode", "day", "week", "month", "quarter", "year"];

function parseRange(ref) {
  if (/^\d{4}-\d{2}-\d{2}$/.test(ref)) return { type: "day", ref };
  if (/^\d{4}-W\d{1,2}$/.test(ref)) {
    const [y, w] = ref.split("-W");
    return { type: "week", ref: `${y}-W${w.padStart(2, "0")}` };
  }
  if (/^\d{4}-\d{2}$/.test(ref)) return { type: "month", ref };
  if (/^\d{4}-Q[1-4]$/.test(ref)) return { type: "quarter", ref };
  if (/^\d{4}$/.test(ref)) return { type: "year", ref };
  return null;
}

function weekDatesLocal(weekStr) {
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

function monthDates(monthStr) {
  const [year, month] = monthStr.split("-").map(Number);
  const dates = [];
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function monthWeeksLocal(monthStr) {
  const dates = monthDates(monthStr);
  return [...new Set(dates.map(d => dateToWeek(d)))].sort();
}

function quarterMonthsLocal(quarterStr) {
  const [yearStr, qStr] = quarterStr.split("-Q");
  const q = parseInt(qStr);
  const start = (q - 1) * 3 + 1;
  return [0, 1, 2].map(i => `${yearStr}-${String(start + i).padStart(2, "0")}`);
}

function yearQuarters(yearStr) {
  return [1, 2, 3, 4].map(q => `${yearStr}-Q${q}`);
}

function rangeToDays(range) {
  switch (range.type) {
    case "day": return [range.ref];
    case "week": return weekDatesLocal(range.ref);
    case "month": return monthDates(range.ref);
    case "quarter": return quarterMonthsLocal(range.ref).flatMap(m => monthDates(m));
    case "year": return yearQuarters(range.ref).flatMap(q => quarterMonthsLocal(q).flatMap(m => monthDates(m)));
  }
}

function sessionsForDays(days) {
  const daySet = new Set(days);
  const files = allSessions();
  const matched = [];
  for (const f of files) {
    const entries = parseSession(f);
    const id = sessionId(entries);
    if (!id || !hasAssistantMessage(entries)) continue;
    const { start, end } = sessionTimestamps(entries);
    const dateStr = toDateStr(end || start || new Date().toISOString());
    if (daySet.has(dateStr)) matched.push(f);
  }
  return matched;
}

async function reprocess(rangeStr, depthStr) {
  const range = parseRange(rangeStr);
  if (!range) { log(`Invalid range: ${rangeStr}`); process.exit(1); }

  const depth = depthStr || "episode";
  if (!LEVELS.includes(depth)) { log(`Invalid depth: ${depthStr}. Use: ${LEVELS.join(", ")}`); process.exit(1); }

  const rangeLevel = LEVELS.indexOf(range.type);
  const depthLevel = LEVELS.indexOf(depth);
  if (depthLevel > rangeLevel) {
    log(`Depth '${depth}' is higher than range '${range.type}' — nothing to do`);
    process.exit(1);
  }

  log(`Reprocess: ${range.ref} (${range.type}) from ${depth} level`);

  const days = rangeToDays(range);
  const activeDays = days.filter(d => existsSync(join(EPISODES_DIR, d)));
  log(`  ${activeDays.length} active days in range`);

  if (depthLevel <= 0) {
    const files = sessionsForDays(days);
    log(`  Episodes: ${files.length} sessions`);
    const CONCURRENCY = parseInt(process.env.REPROCESS_CONCURRENCY || "8");
    let ok = 0, fail = 0, skip = 0;

    async function processEpisode(f) {
      try {
        const entries = parseSession(f);
        const id = sessionId(entries);
        if (!id || !hasAssistantMessage(entries)) { skip++; return; }
        const sessionEntries = entries.filter(e => e.type !== "session");
        let ctx;
        try { ctx = buildSessionContext(sessionEntries); }
        catch (err) { log(`    Context failed ${id.slice(0,8)}: ${err.message?.slice(0,100)}`); fail++; return; }
        if (!ctx.messages.length) { skip++; return; }
        const { start, end } = sessionTimestamps(entries);
        const dateStr = toDateStr(end || start || new Date().toISOString());
        log(`    ${id.slice(0, 8)} (${dateStr}) started`);
        const resolved = await resolveModel(null, "dmn");
        const messages = [
          ...ctx.messages,
          userMessage("Write a journal entry for this session.\n\nRespond in plain text. Do not call any tools."),
        ];
        const result = await complete(resolved, messages, EPISODE_SYSTEM);
        const text = getText(result);
        if (!text || !text.trim()) {
          log(`    ${id.slice(0, 8)} ✗ empty response (stopReason: ${result.stopReason})`);
          fail++; return;
        }
        const fm = buildFrontmatter("pi", f, end || start || new Date().toISOString());
        const dir = join(EPISODES_DIR, dateStr);
        mkdirSync(dir, { recursive: true });
        const epPath = join(dir, `${id}.md`);
        const tmp = epPath + ".tmp";
        writeFileSync(tmp, fm + text, "utf8");
        renameSync(tmp, epPath);
        log(`    ${id.slice(0, 8)} ✓ ${text.length} chars`);
        ok++;
      } catch (err) { log(`    Error: ${err.message?.slice(0, 100)}`); fail++; }
    }

    const pool = new Set();
    for (const f of files) {
      if (pool.size >= CONCURRENCY) await Promise.race(pool);
      const p = processEpisode(f).then(() => pool.delete(p));
      pool.add(p);
    }
    await Promise.all(pool);
    log(`  Episodes done: ${ok} ok, ${fail} failed, ${skip} skipped`);
  }

  if (depthLevel <= 1) {
    log(`  Days: ${activeDays.length} (parallel)`);
    await Promise.all(activeDays.map(async (d) => {
      try {
        const summary = await recall(d, CACHE_Q_DAY, "opus");
        if (!summary || summary.startsWith("[recall:")) throw new Error(summary);
        atomicWrite(join(CACHE_DIR, "days", `${d}.md`), summary);
        log(`    ${d} ✓`);
      } catch (err) { log(`    ${d} ✗ ${err.message?.slice(0, 100)}`); }
    }));
  }

  if (depthLevel <= 2 && rangeLevel >= 2) {
    const weeks = range.type === "week" ? [range.ref]
      : range.type === "month" ? monthWeeksLocal(range.ref)
      : range.type === "quarter" ? quarterMonthsLocal(range.ref).flatMap(m => monthWeeksLocal(m))
      : range.type === "year" ? yearQuarters(range.ref).flatMap(q => quarterMonthsLocal(q).flatMap(m => monthWeeksLocal(m)))
      : [];
    const uniqueWeeks = [...new Set(weeks)].sort();
    log(`  Weeks: ${uniqueWeeks.length} (parallel)`);
    await Promise.all(uniqueWeeks.map(async (w) => {
      try {
        const summary = await recall(w, CACHE_Q_WEEK, "opus");
        if (!summary || summary.startsWith("[recall:")) throw new Error(summary);
        atomicWrite(join(CACHE_DIR, "weeks", `${w}.md`), summary);
        log(`    ${w} ✓`);
      } catch (err) { log(`    ${w} ✗ ${err.message?.slice(0, 100)}`); }
    }));
  }

  if (depthLevel <= 3 && rangeLevel >= 3) {
    const months = range.type === "month" ? [range.ref]
      : range.type === "quarter" ? quarterMonthsLocal(range.ref)
      : range.type === "year" ? yearQuarters(range.ref).flatMap(q => quarterMonthsLocal(q))
      : [];
    log(`  Months: ${months.length} (parallel)`);
    await Promise.all(months.map(async (m) => {
      try {
        const summary = await recall(m, CACHE_Q_MONTH, "opus");
        if (!summary || summary.startsWith("[recall:")) throw new Error(summary);
        atomicWrite(join(CACHE_DIR, "months", `${m}.md`), summary);
        log(`    ${m} ✓`);
      } catch (err) { log(`    ${m} ✗ ${err.message?.slice(0, 100)}`); }
    }));
  }

  if (depthLevel <= 4 && rangeLevel >= 4) {
    const quarters = range.type === "quarter" ? [range.ref]
      : range.type === "year" ? yearQuarters(range.ref)
      : [];
    log(`  Quarters: ${quarters.length}`);
    for (const q of quarters) {
      try {
        const summary = await recall(q, CACHE_Q_QUARTER, "opus");
        if (!summary || summary.startsWith("[recall:")) throw new Error(summary);
        atomicWrite(join(CACHE_DIR, "quarters", `${q}.md`), summary);
        log(`    ${q} ✓`);
      } catch (err) { log(`    ${q} ✗ ${err.message?.slice(0, 100)}`); }
    }
  }

  log("Reprocess complete.");
}

// ============================================================================
// FLUSH
// ============================================================================

const FLUSH_TRIGGER = join(SNORRIO_HOME, "flush");

function startFlushWatcher() {
  setInterval(async () => {
    if (!existsSync(FLUSH_TRIGGER)) return;
    try { unlinkSync(FLUSH_TRIGGER); } catch { return; }
    log("Flush triggered");
    const pending = [...timers.entries()];
    for (const [filePath, timer] of pending) {
      clearTimeout(timer);
      timers.delete(filePath);
    }
    if (pending.length === 0) { log("Flush: 0 sessions to process"); return; }
    log(`Flush: ${pending.length} pending`);

    // Phase 1: Generate episodes (skip cascade — we'll do it ourselves)
    globalThis._skipCascade = true;
    let processed = 0, failed = 0;
    const dates = new Set();
    for (const [filePath] of pending) {
      if (inflight.has(filePath)) continue;
      inflight.add(filePath);
      try {
        const r = await generateEpisode(filePath);
        if (r) { processed++; dates.add(r.dateStr); }
      } catch (err) { log(`Flush error: ${err.message}`); failed++; }
      finally { inflight.delete(filePath); }
    }
    globalThis._skipCascade = false;

    // Phase 2: Regenerate day caches (blocking — /done waits for this)
    for (const dateStr of dates) {
      try {
        log(`  Regenerating day cache: ${dateStr}`);
        const daySummary = await recall(dateStr, CACHE_Q_DAY, "opus");
        if (daySummary && !daySummary.startsWith("[recall:")) {
          atomicWrite(join(CACHE_DIR, "days", `${dateStr}.md`), daySummary);
        }
      } catch (err) { log(`  Day cache error: ${err.message?.slice(0, 100)}`); }
    }

    // Emit summary — /done stops waiting here
    log(`Flush: ${processed} processed, ${pending.length - processed - failed} skipped, ${failed} failed`);

    // Phase 3: Background cascade (week/month/quarter)
    (async () => {
      for (const dateStr of dates) {
        const weekStr = dateToWeek(dateStr);
        const monthStr = dateStr.slice(0, 7);

        try {
          log(`  [bg] Regenerating week cache: ${weekStr}`);
          const weekSummary = await recall(weekStr, CACHE_Q_WEEK, "opus");
          if (weekSummary && !weekSummary.startsWith("[recall:")) {
            atomicWrite(join(CACHE_DIR, "weeks", `${weekStr}.md`), weekSummary);
          }
        } catch (err) { log(`  [bg] Week cache error: ${err.message?.slice(0, 100)}`); }

        if (lastProcessedDate && lastProcessedDate !== dateStr) {
          try {
            log(`  [bg] Regenerating month cache: ${monthStr}`);
            const monthSummary = await recall(monthStr, CACHE_Q_MONTH, "opus");
            if (monthSummary && !monthSummary.startsWith("[recall:")) {
              atomicWrite(join(CACHE_DIR, "months", `${monthStr}.md`), monthSummary);
            }
          } catch (err) { log(`  [bg] Month cache error: ${err.message?.slice(0, 100)}`); }
        }

        if (lastProcessedWeek && lastProcessedWeek !== weekStr) {
          const quarterStr = monthToQuarter(monthStr);
          try {
            log(`  [bg] Regenerating quarter cache: ${quarterStr}`);
            const quarterSummary = await recall(quarterStr, CACHE_Q_QUARTER, "opus");
            if (quarterSummary && !quarterSummary.startsWith("[recall:")) {
              atomicWrite(join(CACHE_DIR, "quarters", `${quarterStr}.md`), quarterSummary);
            }
          } catch (err) { log(`  [bg] Quarter cache error: ${err.message?.slice(0, 100)}`); }
        }

        lastProcessedDate = dateStr;
        lastProcessedWeek = weekStr;
        lastProcessedMonth = monthStr;
      }
      log("  [bg] Background cascade complete");
    })().catch(err => log(`Background cascade error: ${err.message}`));
  }, 1000);
}

function scheduleSweep() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const ms = midnight - now;
  log(`Next sweep in ${Math.round(ms / 60000)}min`);
  setTimeout(async () => {
    try { await sweep(); } catch (err) { log(`Sweep failed: ${err.message}`); }
    scheduleSweep();
  }, ms);
}

// ============================================================================
// FRONTMATTER MIGRATION
// ============================================================================

async function addFrontmatter() {
  log("Building session index...");
  const sessionIndex = new Map();
  const files = allSessions();
  for (const f of files) {
    const entries = parseSession(f);
    const id = sessionId(entries);
    if (!id) continue;
    const { start, end } = sessionTimestamps(entries);
    sessionIndex.set(id, { path: f, start, end });
  }
  log(`  ${sessionIndex.size} sessions indexed`);

  let updated = 0, skipped = 0, notFound = 0;
  const episodeDirs = readdirSync(EPISODES_DIR).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d)).sort();

  for (const dateDir of episodeDirs) {
    const dir = join(EPISODES_DIR, dateDir);
    const episodes = readdirSync(dir).filter(f => f.endsWith(".md"));

    for (const epFile of episodes) {
      const epPath = join(dir, epFile);
      const content = readFileSync(epPath, "utf8");

      if (content.startsWith("---\n")) { skipped++; continue; }

      const sessionUuid = epFile.replace(".md", "");
      const session = sessionIndex.get(sessionUuid);

      const sourcePath = session?.path || "unknown";
      const ts = session ? (session.end || session.start || `${dateDir}T00:00:00Z`) : `${dateDir}T00:00:00Z`;
      if (!session) notFound++;

      const fm = buildFrontmatter("pi", sourcePath, ts);
      atomicWrite(epPath, fm + content);
      updated++;
    }
  }

  log(`Frontmatter migration: ${updated} updated, ${skipped} already had, ${notFound} session not found`);
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  if (process.argv.includes("--add-frontmatter")) { await addFrontmatter(); process.exit(0); }
  if (process.argv.includes("--sweep")) { await sweep(); process.exit(0); }
  const rpIdx = process.argv.indexOf("--reprocess");
  if (rpIdx !== -1) {
    const rangeStr = process.argv[rpIdx + 1];
    const depthStr = process.argv[rpIdx + 2] || undefined;
    if (!rangeStr) {
      console.error("Usage: --reprocess <range> [depth]");
      console.error("  range: YYYY-MM-DD | YYYY-Www | YYYY-MM | YYYY-QN | YYYY");
      console.error("  depth: episode (default) | day | week | month | quarter");
      process.exit(1);
    }
    await reprocess(rangeStr, depthStr);
    process.exit(0);
  }

  log("DMN starting");
  startWatcher();
  startFlushWatcher();
  scheduleSweep();
  log("Ready");

  process.on("SIGINT", () => { log("Shutdown"); process.exit(0); });
  process.on("SIGTERM", () => { log("Shutdown"); process.exit(0); });
}

main().catch(err => { log(`Fatal: ${err.message}`); process.exit(1); });
