#!/usr/bin/env node
// Episode pipeline daemon.
//
// Watches pi session files. After 4:30 of inactivity on a file,
// generates an episode using buildSessionContext + complete().
// Midnight sweep catches anything missed.
//
// No manifest. No state tracking. Idempotent — episodes overwrite freely.
// No minimum message threshold — every session with an assistant message
// gets an episode.
//
// Cache lifecycle:
//   New episode → regenerate day + week caches (atomic write)
//   Day boundary (first episode of new day) → regenerate month, quarter, year
//   All writes are atomic (tmp + rename). No gap where cache is missing.
//   Higher caches are never more than ~24 hours stale.
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
  readFileSync, mkdirSync, existsSync, statSync,
  readdirSync, unlinkSync, appendFileSync,
} from "fs";
import { join, basename } from "path";
import { hostname as osHostname } from "os";
import { complete, getText, userMessage, SNORRIO_HOME, piRoot, getTimezone, CONFIG_PATH } from "./ai.ts";
import { atomicWriteFile as atomicWrite } from "./atomic-write.ts";
import { recall } from "./recall-engine.ts";
import { decideCascade, dateToWeek, monthToQuarter, type CascadeLevel } from "./cascade-decision.ts";
import {
  sessionIdFromPath, sessionIdFromEntries,
  sessionTimestamps as metaTimestamps,
  allSessions as metaAllSessions, type SessionInfo,
} from "./session-meta.ts";

// Side-channel flag used to suppress the cascading temporal-cache rebuild during
// batch operations (--reprocess, midnight sweeps). Read in five places below;
// set by callers that already drive the cascade themselves. Typed here so tsc
// stops complaining about the implicit-any indexing on globalThis.
declare global {
  // eslint-disable-next-line no-var
  var _skipCascade: boolean | undefined;
}

// Lazy pi session manager — only loaded when processing pi sessions
let _piSessionManager: any;

async function getPiSessionManager() {
  if (!_piSessionManager) {
    const root = piRoot();
    if (!root) throw new Error("pi not installed — cannot process pi sessions");
    _piSessionManager = await import(join(root, "dist/core/session-manager.js"));
  }
  return _piSessionManager;
}

const HOME = process.env.HOME!;
const PI_SESSIONS_DIR = join(HOME, ".pi/agent/sessions");
const EPISODES_DIR = join(SNORRIO_HOME, "episodes");
const CACHE_DIR = join(SNORRIO_HOME, "cache");

const DEBOUNCE_MS = 270_000; // 4 minutes 30 seconds
const TZ = getTimezone();

function getMachine() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (cfg.machine) return cfg.machine;
  } catch {}
  return osHostname().replace(/\.local$/, "").toLowerCase();
}
const MACHINE = getMachine();

function buildFrontmatter(origin: string, sourcePath: string, timestamp: string) {
  const source = sourcePath.startsWith(HOME) ? "~" + sourcePath.slice(HOME.length) : sourcePath;
  return `---\norigin: ${origin}\nmachine: ${MACHINE}\nsource: ${source}\ntimestamp: ${timestamp}\n---\n\n`;
}

const timers = new Map();
const inflight = new Set();



const LOG_DIR = join(SNORRIO_HOME, "logs");
mkdirSync(LOG_DIR, { recursive: true });
function log(msg: string) {
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

function toDateStr(iso: string) {
  return new Intl.DateTimeFormat("en-CA", {
    timeZone: TZ, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(new Date(iso));
}

// Parse pi session entries — only used for pi sessions that need buildSessionContext
function parsePiSession(filePath: string) {
  const raw = readFileSync(filePath, "utf8");
  const entries: any[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    try { entries.push(JSON.parse(line)); } catch {}
  }
  return entries;
}

// ============================================================================
// EPISODE GENERATION
// ============================================================================

const EPISODE_SYSTEM = `You write journal entries from coding agent sessions. An entry captures both what was done and what was discussed — the actions, the reasoning, the intent behind them. Include concrete details where they matter: files changed, commands run, decisions made. But equally capture the conversation: what ideas came up, what got debated, what the human cared about, what the tone and energy was. Note session IDs of related sessions when referenced.`;

const EPISODE_PROMPT = "Write a journal entry for this session.\n\nRespond in plain text. Do not call any tools.";

async function generateEpisode(filePath: string) {
  const id = sessionIdFromEntries(filePath);
  if (!id) { log(`  No session ID: ${basename(filePath)}`); return null; }

  const { start, end } = metaTimestamps(filePath);
  const dateStr = toDateStr(end || start || new Date().toISOString());

  log(`  Generating: ${id.slice(0, 8)} (${dateStr})`);

  const { loadEntriesFromFile, buildSessionContext } = await getPiSessionManager();
  const entries = loadEntriesFromFile(filePath);
  const sessionEntries = entries.filter((e: any) => e.type !== "session");

  let ctx: any;
  try {
    ctx = buildSessionContext(sessionEntries);
    if (!ctx.messages.length) {
      // Default leaf may be a branch (e.g. model_change) that misses the conversation.
      // Find the last message entry and use it as explicit leaf.
      for (let i = sessionEntries.length - 1; i >= 0; i--) {
        if (sessionEntries[i].type === "message") {
          ctx = buildSessionContext(sessionEntries, sessionEntries[i].id);
          break;
        }
      }
    }
  } catch (err: any) {
    log(`  Context failed ${id.slice(0, 8)}: ${err.message?.slice(0, 200)}`);
    return null;
  }
  if (!ctx.messages.length) { log(`  Empty context: ${id.slice(0, 8)}`); return null; }

  const messages = [
    ...ctx.messages,
    userMessage(EPISODE_PROMPT),
  ];

  const result = await complete(messages, EPISODE_SYSTEM, null, "dmn");
  if (result.stopReason === "error") {
    log(`  API error ${id.slice(0, 8)}: ${(result.errorMessage || "").slice(0, 200)}`);
    return null;
  }

  const text = getText(result);
  if (!text?.trim()) { log(`  Empty output: ${id.slice(0, 8)}`); return null; }

  const fm = buildFrontmatter("pi", filePath, end || start || new Date().toISOString());
  const dir = join(EPISODES_DIR, dateStr);
  mkdirSync(dir, { recursive: true });
  const epPath = join(dir, `${id}.md`);
  atomicWrite(epPath, fm + text);

  log(`  Done: ${id.slice(0, 8)} → ${text.length} chars`);

  if (!globalThis._skipCascade) {
    await cascadeForDate(dateStr);
  }

  return { id, dateStr, path: epPath };
}

// ============================================================================
// TEMPORAL HELPERS
// ============================================================================

const CACHE_Q_DAY = "Tell the story of today — write it as a narrative, not a checklist. What was worked on, what got decided, what changed. Track commitments made for today, but don't carry weekly or longer-term goals — just mention them naturally so higher levels can pick them up. Include session IDs so any thread can be traced back to its source.";
const CACHE_Q_WEEK = "Write a narrative of this week so far — an essay, not a checklist. What threads are developing, what started or stalled, what's the trajectory? Don't repeat daily details — just what's visible across multiple days. You're the continuity layer across day boundaries — anything in flight that a new day needs to pick up should be here, with enough detail to find the right day. Reference specific dates so the reader can navigate down.";
const CACHE_Q_MONTH = "Write a narrative of this month so far — an essay, not a checklist. What shifted, what themes emerged or faded, what's shaping the direction? Don't restate weekly details — just what's visible at the monthly level. You're the continuity layer across week boundaries — any active threads a new week needs to carry forward should be here, with enough context to find the right week. Reference specific weeks so the reader can navigate down.";
const CACHE_Q_QUARTER = "Write a narrative of this quarter so far — an essay, not a checklist. What's the arc, what materialized that wasn't there at the start, what's building? Don't restate monthly details — just what's visible from this altitude. You're the continuity layer across month boundaries — any arcs a new month needs to carry forward should be here, with enough context to find the right month. Reference specific months so the reader can navigate down.";
const CACHE_Q_YEAR = "Write a narrative of this year so far. Every thread surfaced at the quarter level should be carried here — not restated in full, but faithfully represented at a higher level of abstraction so any of them can be drilled into. No thread should disappear between quarters and the year.\n\nGround every claim in what the quarter summaries actually say. If a quarter doesn't state an outcome, don't infer one. Say what's known and what's unresolved — never fabricate a status.\n\nWhat's the through-line? What transformed? What emerged that wasn't imaginable at the start? What's visible from this altitude that no single quarter can see? Surface cross-quarter arcs and tensions, but stay anchored to what actually happened. Reference specific quarters so the reader can navigate down.";

async function cascadeForDate(dateStr: string) {
  // Only called in live mode (debounce path) — _skipCascade gates this.
  // Historical paths (flush/sweep/reprocess) handle their own cascading.
  // In live mode, always full cascade: episodes arrive one at a time
  // with 4.5min debounce, so there's no thrashing risk.
  await batchCascade(new Set([dateStr]), "day");
}

// Rebuild caches for a set of refs at one level.
// Parallel for day/week/month, sequential for quarter/year.
async function rebuildCache(level: string, refs: string[], prefix: string = "") {
  const prompts: Record<string, string> = {
    day: CACHE_Q_DAY, week: CACHE_Q_WEEK, month: CACHE_Q_MONTH,
    quarter: CACHE_Q_QUARTER, year: CACHE_Q_YEAR,
  };
  const dirs: Record<string, string> = {
    day: "days", week: "weeks", month: "months",
    quarter: "quarters", year: "years",
  };
  if (refs.length === 0) return;
  log(`${prefix}  Rebuilding ${refs.length} ${level} cache${refs.length > 1 ? "s" : ""}`);

  const rebuild = async (ref: string) => {
    try {
      const summary = await recall(ref, prompts[level], "opus");
      if (summary && !summary.startsWith("[recall:"))
        atomicWrite(join(CACHE_DIR, dirs[level], `${ref}.md`), summary as string);
      log(`${prefix}    ${ref} ✓`);
    } catch (err: any) { log(`${prefix}    ${ref} ✗ ${err.message?.slice(0, 100)}`); }
  };

  if (["day", "week", "month"].includes(level)) await Promise.all(refs.map(rebuild));
  else for (const ref of refs) await rebuild(ref);
}

// Walk the cache tree bottom-up, rebuilding anything where a child is newer than its parent.
// Runs independently of what episodes were just generated — catches incomplete cascades.
async function validateCaches(prefix: string = "") {
  const dirs: Record<string, string> = {
    day: "days", week: "weeks", month: "months", quarter: "quarters", year: "years",
  };
  const cachePath = (level: string, ref: string) => join(CACHE_DIR, dirs[level], `${ref}.md`);
  const mtime = (p: string) => { try { return statSync(p).mtimeMs; } catch { return 0; } };

  // Ground truth starts from episodes, not existing day caches.
  let allDays: string[] = [];
  try {
    allDays = readdirSync(EPISODES_DIR)
      .filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d))
      .filter(d => {
        try { return readdirSync(join(EPISODES_DIR, d)).some(f => f.endsWith(".md")); }
        catch { return false; }
      })
      .sort();
  } catch {}
  if (!allDays.length) return;

  // Check day caches: missing or older than any episode in that day?
  const staleDays: string[] = [];
  for (const day of allDays) {
    const dayCacheMtime = mtime(cachePath("day", day));
    let latestEpisodeMtime = 0;
    try {
      for (const f of readdirSync(join(EPISODES_DIR, day))) {
        if (!f.endsWith(".md")) continue;
        latestEpisodeMtime = Math.max(latestEpisodeMtime, mtime(join(EPISODES_DIR, day, f)));
      }
    } catch {}
    if (!dayCacheMtime || latestEpisodeMtime > dayCacheMtime) staleDays.push(day);
  }
  if (staleDays.length) await rebuildCache("day", [...new Set(staleDays)].sort(), prefix);

  // Check weeks: any week where a day cache is newer?
  const weekDays = new Map<string, string[]>();
  for (const d of allDays) {
    const w = dateToWeek(d);
    if (!weekDays.has(w)) weekDays.set(w, []);
    weekDays.get(w)!.push(d);
  }
  const staleWeeks: string[] = [];
  for (const [week, days] of weekDays) {
    const wt = mtime(cachePath("week", week));
    if (days.some(d => mtime(cachePath("day", d)) > wt)) staleWeeks.push(week);
  }
  if (staleWeeks.length) await rebuildCache("week", staleWeeks.sort(), prefix);

  // Check months: any month where a week cache is newer?
  const allWeeks = [...weekDays.keys()];
  const monthWeeks = new Map<string, string[]>();
  for (const d of allDays) {
    const m = d.slice(0, 7);
    if (!monthWeeks.has(m)) monthWeeks.set(m, []);
  }
  for (const w of allWeeks) {
    // Map week to its months (a week can span two months; use the days)
    for (const d of weekDays.get(w)!) {
      const m = d.slice(0, 7);
      if (monthWeeks.has(m) && !monthWeeks.get(m)!.includes(w)) monthWeeks.get(m)!.push(w);
    }
  }
  const staleMonths: string[] = [];
  for (const [month, weeks] of monthWeeks) {
    const mt = mtime(cachePath("month", month));
    if (weeks.some(w => mtime(cachePath("week", w)) > mt)) staleMonths.push(month);
  }
  if (staleMonths.length) await rebuildCache("month", staleMonths.sort(), prefix);

  // Check quarters: any quarter where a month cache is newer?
  const allMonths = [...monthWeeks.keys()];
  const quarterMonths = new Map<string, string[]>();
  for (const m of allMonths) {
    const q = monthToQuarter(m);
    if (!quarterMonths.has(q)) quarterMonths.set(q, []);
    quarterMonths.get(q)!.push(m);
  }
  const staleQuarters: string[] = [];
  for (const [quarter, months] of quarterMonths) {
    const qt = mtime(cachePath("quarter", quarter));
    if (months.some(m => mtime(cachePath("month", m)) > qt)) staleQuarters.push(quarter);
  }
  if (staleQuarters.length) {
    for (const q of staleQuarters.sort()) await rebuildCache("quarter", [q], prefix);
  }

  // Check years: any year where a quarter cache is newer?
  const allQuarters = [...quarterMonths.keys()];
  const yearQuartersMap = new Map<string, string[]>();
  for (const q of allQuarters) {
    const y = q.split("-")[0];
    if (!yearQuartersMap.has(y)) yearQuartersMap.set(y, []);
    yearQuartersMap.get(y)!.push(q);
  }
  const staleYears: string[] = [];
  for (const [year, quarters] of yearQuartersMap) {
    const yt = mtime(cachePath("year", year));
    if (quarters.some(q => mtime(cachePath("quarter", q)) > yt)) staleYears.push(year);
  }
  if (staleYears.length) {
    for (const y of staleYears.sort()) await rebuildCache("year", [y], prefix);
  }
}

// Derive unique refs at each level from a set of dates, rebuild bottom-up.
// `from` controls the starting level: "day" | "week" | "month" | "quarter" | "year".
// Pure decision lives in cascade-decision.ts; this wrapper does the IO.
async function batchCascade(dates: Set<string>, from: string = "day", prefix: string = "") {
  const decision = decideCascade(dates, from as CascadeLevel);
  for (const level of ["day", "week", "month", "quarter", "year"] as CascadeLevel[]) {
    const refs = decision[level];
    if (refs.length) await rebuildCache(level, refs, prefix);
  }
}

// ============================================================================
// WATCHER
// ============================================================================

function onSessionChange(filePath: string) {
  if (!filePath.endsWith(".jsonl")) return;
  if (timers.has(filePath)) clearTimeout(timers.get(filePath));
  timers.set(filePath, setTimeout(async () => {
    timers.delete(filePath);
    if (inflight.has(filePath)) return;
    inflight.add(filePath);
    log(`Debounce fired: ${basename(filePath).slice(0, 50)}`);
    try { await generateEpisode(filePath); }
    catch (err: any) { log(`Error: ${err.message}`); }
    finally { inflight.delete(filePath); }
  }, DEBOUNCE_MS));
}

function startWatcher() {
  if (existsSync(PI_SESSIONS_DIR)) {
    log(`Watching: ${PI_SESSIONS_DIR}`);
    watch(PI_SESSIONS_DIR, { recursive: true }, (_, filename) => {
      if (!filename?.endsWith(".jsonl")) return;
      onSessionChange(join(PI_SESSIONS_DIR, filename));
    });
  }
}

// ============================================================================
// SWEEP / REPROCESS
// ============================================================================

async function sweep() {
  log("Sweep starting...");
  globalThis._skipCascade = true;
  const sessions = metaAllSessions();
  let ok = 0, exists = 0, fail = 0;
  const CONCURRENCY = parseInt(process.env.REPROCESS_CONCURRENCY || "8");
  const touchedDays = new Set<string>();

  const todo: SessionInfo[] = [];
  for (const s of sessions) {
    const { start, end } = metaTimestamps(s.path);
    const dateStr = toDateStr(end || start || new Date().toISOString());
    const epPath = join(EPISODES_DIR, dateStr, `${s.id}.md`);
    if (existsSync(epPath)) {
      const sessionMtime = statSync(s.path).mtimeMs;
      const episodeMtime = statSync(epPath).mtimeMs;
      if (sessionMtime <= episodeMtime) { exists++; continue; }
      log(`  Stale episode: ${s.id.slice(0, 8)} (session newer by ${Math.round((sessionMtime - episodeMtime) / 1000)}s)`);
    }
    todo.push(s);
  }
  log(`  ${todo.length} need episodes, ${exists} exist`);

  const pool = new Set<Promise<void>>();
  for (const s of todo) {
    if (pool.size >= CONCURRENCY) await Promise.race(pool);
    const p = (async () => {
      try {
        const r = await generateEpisode(s.path);
        if (r) { ok++; touchedDays.add(r.dateStr); }
        else { fail++; }
      } catch (err: any) {
        fail++;
        log(`Sweep error ${s.id.slice(0, 8)}: ${err.message}`);
      }
    })().then(() => { pool.delete(p); });
    pool.add(p);
  }
  await Promise.all(pool);
  log(`  Episodes: ${ok} ok, ${exists} exist${fail ? `, ${fail} error` : ""}`);

  // Rebuild day caches for touched days
  if (touchedDays.size > 0) {
    await rebuildCache("day", [...touchedDays].sort());
  }

  // Validate entire cache tree — catches incomplete cascades from previous runs
  await validateCaches();

  globalThis._skipCascade = false;
  log(`Sweep done: ${ok} episodes, ${touchedDays.size} days touched`);
}

// ============================================================================
// REPROCESS
// ============================================================================

const LEVELS = ["episode", "day", "week", "month", "quarter", "year"];

function parseRange(ref: string) {
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

function weekDatesLocal(weekStr: string) {
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

function monthDates(monthStr: string) {
  const [year, month] = monthStr.split("-").map(Number);
  const dates: string[] = [];
  const d = new Date(year, month - 1, 1);
  while (d.getMonth() === month - 1) {
    dates.push(d.toISOString().slice(0, 10));
    d.setDate(d.getDate() + 1);
  }
  return dates;
}

function monthWeeksLocal(monthStr: string) {
  const dates = monthDates(monthStr);
  return [...new Set(dates.map(d => dateToWeek(d)))].sort();
}

function quarterMonthsLocal(quarterStr: string) {
  const [yearStr, qStr] = quarterStr.split("-Q");
  const q = parseInt(qStr);
  const start = (q - 1) * 3 + 1;
  return [0, 1, 2].map(i => `${yearStr}-${String(start + i).padStart(2, "0")}`);
}

function yearQuarters(yearStr: string) {
  return [1, 2, 3, 4].map(q => `${yearStr}-Q${q}`);
}

function rangeToDays(range: { type: string; ref: string }): string[] {
  switch (range.type) {
    case "day": return [range.ref];
    case "week": return weekDatesLocal(range.ref);
    case "month": return monthDates(range.ref);
    case "quarter": return quarterMonthsLocal(range.ref).flatMap(m => monthDates(m));
    case "year": return yearQuarters(range.ref).flatMap(q => quarterMonthsLocal(q).flatMap(m => monthDates(m)));
    default: return [];
  }
}

function sessionsForDays(days: string[]) {
  const daySet = new Set(days);
  const sessions = metaAllSessions();
  const matched: SessionInfo[] = [];
  for (const s of sessions) {
    const { start, end } = metaTimestamps(s.path);
    const dateStr = toDateStr(end || start || new Date().toISOString());
    if (daySet.has(dateStr)) matched.push(s);
  }
  return matched;
}

async function reprocess(rangeStr: string, depthStr?: string) {
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
    const sessions = sessionsForDays(days);
    log(`  Episodes: ${sessions.length} sessions`);
    const CONCURRENCY = parseInt(process.env.REPROCESS_CONCURRENCY || "8");
    let ok = 0, fail = 0, skip = 0;

    async function processEpisode(s: SessionInfo) {
      try {
        const { start, end } = metaTimestamps(s.path);
        const dateStr = toDateStr(end || start || new Date().toISOString());
        log(`    ${s.id.slice(0, 8)} (${dateStr}) started`);

        const { loadEntriesFromFile, buildSessionContext } = await getPiSessionManager();
        const entries = loadEntriesFromFile(s.path);
        const sessionEntries = entries.filter((e: any) => e.type !== "session");
        let ctx: any;
        try {
          ctx = buildSessionContext(sessionEntries);
          if (!ctx.messages.length) {
            for (let i = sessionEntries.length - 1; i >= 0; i--) {
              if (sessionEntries[i].type === "message") {
                ctx = buildSessionContext(sessionEntries, sessionEntries[i].id);
                break;
              }
            }
          }
        } catch (err: any) { log(`    Context failed ${s.id.slice(0,8)}: ${err.message?.slice(0,100)}`); fail++; return; }
        if (!ctx.messages.length) { skip++; return; }

        const messages = [...ctx.messages, userMessage(EPISODE_PROMPT)];
        const result = await complete(messages, EPISODE_SYSTEM, null, "dmn");
        const text = getText(result);
        if (!text?.trim()) {
          log(`    ${s.id.slice(0, 8)} ✗ empty response (stopReason: ${result.stopReason})`);
          fail++; return;
        }

        const fm = buildFrontmatter("pi", s.path, end || start || new Date().toISOString());
        const dir = join(EPISODES_DIR, dateStr);
        mkdirSync(dir, { recursive: true });
        const epPath = join(dir, `${s.id}.md`);
        atomicWrite(epPath, fm + text);
        log(`    ${s.id.slice(0, 8)} ✓ ${text.length} chars`);
        ok++;
      } catch (err: any) { log(`    Error: ${err.message?.slice(0, 100)}`); fail++; }
    }

    const pool = new Set<Promise<void>>();
    for (const s of sessions) {
      if (pool.size >= CONCURRENCY) await Promise.race(pool);
      const p = processEpisode(s).then(() => { pool.delete(p); });
      pool.add(p);
    }
    await Promise.all(pool);
    log(`  Episodes done: ${ok} ok, ${fail} failed, ${skip} skipped`);
  }

  if (depthLevel <= 1) {
    await rebuildCache("day", activeDays);
  }

  if (depthLevel <= 2 && rangeLevel >= 2) {
    const weeks = range.type === "week" ? [range.ref]
      : range.type === "month" ? monthWeeksLocal(range.ref)
      : range.type === "quarter" ? quarterMonthsLocal(range.ref).flatMap(m => monthWeeksLocal(m))
      : range.type === "year" ? yearQuarters(range.ref).flatMap(q => quarterMonthsLocal(q).flatMap(m => monthWeeksLocal(m)))
      : [];
    await rebuildCache("week", [...new Set(weeks)].sort());
  }

  if (depthLevel <= 3 && rangeLevel >= 3) {
    const months = range.type === "month" ? [range.ref]
      : range.type === "quarter" ? quarterMonthsLocal(range.ref)
      : range.type === "year" ? yearQuarters(range.ref).flatMap(q => quarterMonthsLocal(q))
      : [];
    await rebuildCache("month", months);
  }

  if (depthLevel <= 4 && rangeLevel >= 4) {
    const quarters = range.type === "quarter" ? [range.ref]
      : range.type === "year" ? yearQuarters(range.ref)
      : [];
    await rebuildCache("quarter", quarters);
  }

  if (depthLevel <= 5 && rangeLevel >= 5) {
    await rebuildCache("year", [range.ref]);
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
    const dates = new Set<string>();
    for (const [filePath] of pending) {
      if (inflight.has(filePath)) continue;
      inflight.add(filePath);
      try {
        const r = await generateEpisode(filePath);
        if (r) { processed++; dates.add(r.dateStr); }
        else { failed++; }
      } catch (err: any) { log(`Flush error: ${err.message}`); failed++; }
      finally { inflight.delete(filePath); }
    }
    globalThis._skipCascade = false;

    // Phase 2: Regenerate day caches (blocking — /done waits for this)
    for (const dateStr of dates) {
      try {
        log(`  Regenerating day cache: ${dateStr}`);
        const daySummary = await recall(dateStr, CACHE_Q_DAY, "opus");
        if (daySummary && !daySummary.startsWith("[recall:")) {
          atomicWrite(join(CACHE_DIR, "days", `${dateStr}.md`), daySummary as string);
        }
      } catch (err: any) { log(`  Day cache error: ${err.message?.slice(0, 100)}`); }
    }

    // Emit summary — /done stops waiting here
    log(`Flush: ${processed} processed, ${failed} failed`);

    // Phase 3: Background cascade — deduplicated
    (async () => {
      await batchCascade(dates as Set<string>, "week", "[bg]");
      log("  [bg] Background cascade complete");
    })().catch(err => log(`Background cascade error: ${err.message}`));
  }, 1000);
}

function scheduleSweep() {
  const now = new Date();
  const midnight = new Date(now);
  midnight.setHours(24, 0, 0, 0);
  const ms = (midnight as any) - (now as any);
  log(`Next sweep in ${Math.round(ms / 60000)}min`);
  setTimeout(async () => {
    try { await sweep(); } catch (err: any) { log(`Sweep failed: ${err.message}`); }
    scheduleSweep();
  }, ms);
}

// ============================================================================
// FRONTMATTER MIGRATION
// ============================================================================

async function addFrontmatter() {
  log("Building session index...");
  const sessionIndex = new Map<string, { path: string; start: string | null; end: string | null }>();
  const sessions = metaAllSessions();
  for (const s of sessions) {
    const { start, end } = metaTimestamps(s.path);
    sessionIndex.set(s.id, { path: s.path, start, end });
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

      const origin = "pi";
      const fm = buildFrontmatter(origin, sourcePath, ts);
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
