#!/usr/bin/env node
// Episode pipeline daemon.
//
// Watches pi session files. After DEBOUNCE_MS of inactivity on a file (55min),
// generates an episode using buildSessionContext + complete().
// `snorrio flush` skips the wait; midnight sweep catches anything missed.
//
// No manifest. No state tracking. Idempotent — episodes overwrite freely.
// No minimum message threshold — every session with an assistant message
// gets an episode.
//
// Cache lifecycle:
//   New episode (live mode) → cascade day → week → month → quarter → year
//     for that date. No first-episode-of-day detection — every episode
//     unconditionally rebuilds the full stack (~7 min of serial LLM calls), so
//     the DEBOUNCE_MS window is what bounds how often that runs; batch paths
//     (--reprocess, midnight sweep) set
//     `_skipCascade` and drive their own deduplicated batchCascade at the
//     end. Pure decision lives in cascade-decision.ts.
//   All writes are atomic (tmp + rename + cleanup-on-failure via
//     atomicWriteFile). No gap where cache is missing.
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
import { complete, getText, userMessage, SNORRIO_HOME, piRoot, getTimezone, CONFIG_PATH } from "./ai.ts";
import { sessionMessagesToLlm, type RawSessionMessage } from "./model-independence.ts";
import { atomicWriteFile as atomicWrite } from "./atomic-write.ts";
import { ensureDataRepo, commitDataRepo } from "./data-repo.ts";
import { recall } from "./recall-engine.ts";
import { withRetries } from "./retry.ts";
import { decideCascade, dateToWeek, monthToQuarter, type CascadeLevel } from "./cascade-decision.ts";
import { findStaleSessions } from "./stale-sessions.ts";
import { buildEpisodeIndex } from "./episode-index.ts";
import { monthDates, monthWeeks, quarterMonths, weekDates, yearQuarters } from "./date-ranges.ts";
import { resolveLocalDate, resolveUtcOffset } from "./local-date.ts";
import { createZoneResolver, tzJournalPath } from "./tz-journal.ts";
import {
  sessionIdFromEntries,
  sessionTimestamps as metaTimestamps,
  allSessions as metaAllSessions, type SessionInfo,
} from "./session-meta.ts";
import { getSessionLineageIndex, type SessionLineage, type SessionLineageIndex } from "./session-lineage.ts";
import { buildEpisodeFrontmatter, defaultMachine, type EpisodeLocalDate } from "./episode-frontmatter.ts";
import { migrateEpisodeLocalDates } from "./local-date-migration.ts";
import { cacheManifestNeedsRefresh, writeCacheWithProvenance, type CacheLevel } from "./cache-provenance.ts";
import { migrateProvenanceMetadata, planProvenanceRecascade, writeProvenanceRecascadeMarker } from "./provenance-migration.ts";
import { externalLineageSessionCandidates, lineageSessionCandidates } from "./session-candidates.ts";

// Side-channel flag used to suppress the cascading temporal-cache rebuild during
// batch operations (--reprocess, midnight sweeps). Read in five places below;
// set by callers that already drive the cascade themselves. Typed here so tsc
// stops complaining about the implicit-any indexing on globalThis.
declare global {
  // eslint-disable-next-line no-var
  var _skipCascade: boolean | undefined;
}

// Minimal local description of pi's session-manager surface. pi is a dynamic,
// optional dependency loaded from the *global* install at runtime, so we do NOT
// depend on its published types (mirrors ai.ts treating pi-ai as `any`). Describe
// only what snorrio touches. Messages come in as RawSessionMessage (loose: pi
// control entries — branchSummary, compactionSummary, bashExecution — carry no
// content); sessionMessagesToLlm() narrows them to strict, content-bearing
// Message[] at the read boundary before complete().
interface SessionEntry { type?: string; id?: string; [k: string]: unknown }
type FileEntry = SessionEntry;
interface SessionContext { messages: RawSessionMessage[] }

// The dynamic `import()` of a runtime-computed path is `any` to tsc; assign it to
// this typed surface (any→typed is a legal assignment, no cast).
interface PiSessionManager {
  loadEntriesFromFile(filePath: string): FileEntry[];
  buildSessionContext(entries: SessionEntry[], leafId?: string | null): SessionContext;
}

let _piSessionManager: PiSessionManager | undefined;

async function getPiSessionManager(): Promise<PiSessionManager> {
  if (_piSessionManager) return _piSessionManager;
  const root = piRoot();
  if (!root) throw new Error("pi not installed — cannot process pi sessions");
  // RHS is `any` (runtime-computed specifier); assigns to PiSessionManager
  // without a cast. The module genuinely exports this surface.
  return (_piSessionManager = await import(join(root, "dist/core/session-manager.js")));
}

const HOME = process.env.HOME!;
const PI_SESSIONS_DIR = join(HOME, ".pi/agent/sessions");
const EPISODES_DIR = join(SNORRIO_HOME, "episodes");
const CACHE_DIR = join(SNORRIO_HOME, "cache");

// Wait for a session to go quiet before generating its episode.
//
// Was 4:30, chosen to land inside Anthropic's 5-minute prompt cache so a
// re-fired session reused its transcript prefix. Two things changed: the 1-hour
// cache TTL exists now and the daemon asks for it (PI_CACHE_RETENTION=long in
// the unit file), and 4:30 meant an active session re-generated its episode
// every few minutes, each time triggering a full day→year cascade — five LLM
// calls, ~7 minutes. Two live sessions were enough to keep the daemon
// permanently busy rebuilding summaries that the next write invalidated.
//
// 55 minutes sits just inside the 1-hour cache window, so a long session that
// re-fires still reads its prefix from cache instead of paying for it again.
// The cost is latency: a finished session's episode can be up to an hour late.
// `snorrio flush` cancels every pending timer and reconciles against disk, so
// that wait is always skippable on demand.
const DEBOUNCE_MS = 3_300_000; // 55 minutes — just inside the 1h prompt cache

// Which zone an instant belongs to is asked PER INSTANT, from the journal.
//
// This was `const TZ = getTimezone()` at module load, which is two bugs in one
// line. The first is temporal: it answers "where is this machine now?" and then
// applies that answer to every timestamp it is ever handed, so a sweep that
// generates a July episode in October buckets it in October's zone. The second
// is lifetime: a daemon that has been up for weeks never observes a zone change
// at all until it is restarted. A resolver keyed on the instant fixes both, and
// re-reads the journal when it changes on disk.
const resolveZoneFor = createZoneResolver({
  path: tzJournalPath(SNORRIO_HOME),
  fallbackZone: getTimezone,
  onError: (message) => log(`WARNING: ${message}`),
});

function getMachine() {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    if (cfg.machine) return cfg.machine;
  } catch {}
  return defaultMachine();
}
const MACHINE = getMachine();
let activeLineageIndex: SessionLineageIndex | null = null;

function lineageForSession(sourcePath: string, sessionId: string): SessionLineage {
  const indexed = (activeLineageIndex ?? getSessionLineageIndex()).getByPath(sourcePath);
  if (indexed) return indexed;
  // A just-created session can race the directory walk. Preserve a complete,
  // directly recallable standalone identity rather than omitting provenance.
  return {
    sessionId,
    sessionPath: sourcePath,
    parentSessionId: null,
    rootSessionId: sessionId,
    provenanceFamilyId: sessionId,
    lineageDepth: 0,
    lineageSource: "none",
    lineageComplete: true,
    lineageConflict: false,
    dependencySessionIds: [],
    issues: [],
  };
}

// The bucketing key, resolved at generation time for the SESSION'S instant and
// then frozen into the episode.
//
// `tz_source` reports who answered: "journal" when an era covered the instant,
// "assumed" when the instant precedes the journal and its earliest era was
// extended backwards, "system" when there is no journal at all. The distinction
// is the point — an inferred zone must not be recorded as an observed one.
function localDateFor(timestamp: string): EpisodeLocalDate {
  const instant = new Date(timestamp);
  const zone = resolveZoneFor(instant);
  return {
    localDate: resolveLocalDate(instant, zone.tz).date,
    tz: zone.tz,
    utcOffset: resolveUtcOffset(instant, zone.tz),
    tzSource: zone.source,
  };
}

function buildFrontmatter(origin: string, sourcePath: string, timestamp: string, sessionId: string) {
  return buildEpisodeFrontmatter({
    origin,
    machine: MACHINE,
    sourcePath,
    home: HOME,
    timestamp,
    lineage: lineageForSession(sourcePath, sessionId),
    localDate: localDateFor(timestamp),
  });
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

// The day directory an instant belongs to, in the zone that was in effect AT
// that instant. Must agree with localDateFor() — same resolver, same instant.
function toDateStr(iso: string) {
  const instant = new Date(iso);
  return resolveLocalDate(instant, resolveZoneFor(instant).tz).date;
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

// A day whose summary was already written just gained a new episode.
//
// This is legitimate and the cascade already handles it — validateCaches()
// compares episode mtimes against the day cache and cacheManifestNeedsRefresh()
// diffs the provenance manifest, so the day and everything above it rebuild. No
// redesign needed. It is worth a log line because day buckets stop being
// monotonic the moment you travel west: Stockholm 22:00Z buckets to Sep 2, then
// a flight, and LA 02:00Z — four hours LATER in absolute time — buckets to
// Sep 1. (Eastward travel just skips a date, which is harmless: the cascade only
// walks days that have episodes.)
//
// The same log line is also what a WRONGLY set journal looks like, which is the
// real reason to emit it: if days start reopening without anyone travelling, the
// zone in effect is not the zone the machine is in.
function noteReopenedDay(dateStr: string, epPath: string, id: string) {
  if (existsSync(epPath)) return; // regeneration of a known episode, not a reopen
  if (!existsSync(join(CACHE_DIR, "days", `${dateStr}.md`))) return;
  log(`  Reopened day ${dateStr}: episode ${id.slice(0, 8)} landed after its day summary was written — cascade will rebuild it. Expected after travelling west; otherwise check \`snorrio tz\`.`);
}

async function generateEpisode(filePath: string) {
  const id = sessionIdFromEntries(filePath);
  if (!id) { log(`  No session ID: ${basename(filePath)}`); return null; }

  const { start, end } = metaTimestamps(filePath);
  const dateStr = toDateStr(end || start || new Date().toISOString());

  log(`  Generating: ${id.slice(0, 8)} (${dateStr})`);

  const { loadEntriesFromFile, buildSessionContext } = await getPiSessionManager();
  const entries = loadEntriesFromFile(filePath);
  // loadEntriesFromFile returns FileEntry[] (includes the session header);
  // dropping the "session" entry narrows to SessionEntry[] for buildSessionContext.
  const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");

  let ctx: SessionContext;
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
    ...sessionMessagesToLlm(ctx.messages),
    userMessage(EPISODE_PROMPT),
  ];

  const result = await complete(messages, EPISODE_SYSTEM, null, "dmn");
  if (result.stopReason === "error") {
    log(`  API error ${id.slice(0, 8)}: ${(result.errorMessage || "").slice(0, 200)}`);
    return null;
  }

  const text = getText(result);
  if (!text?.trim()) { log(`  Empty output: ${id.slice(0, 8)}`); return null; }

  const timestamp = end || start || new Date().toISOString();
  const fm = buildFrontmatter("pi", filePath, timestamp, id);
  const dir = join(EPISODES_DIR, dateStr);
  mkdirSync(dir, { recursive: true });
  const epPath = join(dir, `${id}.md`);
  noteReopenedDay(dateStr, epPath, id);
  atomicWrite(epPath, fm + text);

  log(`  Done: ${id.slice(0, 8)} → ${text.length} chars`);

  if (!globalThis._skipCascade) {
    await cascadeForDate(dateStr);
    // One commit per cascade batch: the triggering episode + every regenerated
    // cache. Author date = world-time of the triggering session; committer
    // date = now. Never throws — a git failure must not block memory.
    commitDataRepo({
      message: `cascade ${dateStr}: episode ${id.slice(0, 8)} → day/week/month/quarter/year`,
      authorDate: timestamp,
    });
  }

  return { id, dateStr, path: epPath, timestamp };
}

// ============================================================================
// TEMPORAL HELPERS
// ============================================================================

const PROVENANCE_CACHE_RULE = " Treat each provenance_family_id as ONE evidence source, including when the same family spans dates. Preserve exact provenance_family_id values and session IDs in the synthesis. Parent restatements and child results in one family are not independent corroboration; incomplete lineage must remain labeled incomplete.";
const CACHE_Q_DAY = "Tell the story of today — write it as a narrative, not a checklist. What was worked on, what got decided, what changed. Track commitments made for today, but don't carry weekly or longer-term goals — just mention them naturally so higher levels can pick them up. Include session IDs so any thread can be traced back to its source." + PROVENANCE_CACHE_RULE;
const CACHE_Q_WEEK = "Write a narrative of this week so far — an essay, not a checklist. What threads are developing, what started or stalled, what's the trajectory? Don't repeat daily details — just what's visible across multiple days. You're the continuity layer across day boundaries — anything in flight that a new day needs to pick up should be here, with enough detail to find the right day. Reference specific dates so the reader can navigate down." + PROVENANCE_CACHE_RULE;
const CACHE_Q_MONTH = "Write a narrative of this month so far — an essay, not a checklist. What shifted, what themes emerged or faded, what's shaping the direction? Don't restate weekly details — just what's visible at the monthly level. You're the continuity layer across week boundaries — any active threads a new week needs to carry forward should be here, with enough context to find the right week. Reference specific weeks so the reader can navigate down." + PROVENANCE_CACHE_RULE;
const CACHE_Q_QUARTER = "Write a narrative of this quarter so far — an essay, not a checklist. What's the arc, what materialized that wasn't there at the start, what's building? Don't restate monthly details — just what's visible from this altitude. You're the continuity layer across month boundaries — any arcs a new month needs to carry forward should be here, with enough context to find the right month. Reference specific months so the reader can navigate down." + PROVENANCE_CACHE_RULE;
const CACHE_Q_YEAR = "Write a narrative of this year so far. Every thread surfaced at the quarter level should be carried here — not restated in full, but faithfully represented at a higher level of abstraction so any of them can be drilled into. No thread should disappear between quarters and the year.\n\nGround every claim in what the quarter summaries actually say. If a quarter doesn't state an outcome, don't infer one. Say what's known and what's unresolved — never fabricate a status.\n\nWhat's the through-line? What transformed? What emerged that wasn't imaginable at the start? What's visible from this altitude that no single quarter can see? Surface cross-quarter arcs and tensions, but stay anchored to what actually happened. Reference specific quarters so the reader can navigate down." + PROVENANCE_CACHE_RULE;

async function cascadeForDate(dateStr: string) {
  // Only called in live mode (debounce path) — _skipCascade gates this.
  // Historical paths (flush/sweep/reprocess) handle their own cascading.
  // In live mode, always full cascade: episodes arrive one at a time and the
  // 55min debounce keeps this from re-running while a session is still active.
  // A full cascade is five serial LLM calls (~7min), so that window is what
  // makes an unconditional rebuild affordable.
  await batchCascade(new Set([dateStr]), "day");
}

// Rebuild caches for a set of refs at one level.
// Parallel for day/week/month, sequential for quarter/year.
//
// Returns the refs that could not be rebuilt. `strict` callers used to get an
// exception on the first failure, which threw away every sibling that had
// already succeeded: on 2026-08-24 a 26-day migration aborted entirely because
// one day returned no summary under 26-way parallel LLM load, while that same
// day rebuilt fine on its own moments later. A single flaky provider response
// must not discard 25 good rebuilds, so failures are retried and then reported
// to the caller, which decides what remains outstanding.
const REBUILD_ATTEMPTS = 3;

async function rebuildCache(
  level: CacheLevel,
  refs: string[],
  prefix: string = "",
  strict: boolean = false,
): Promise<string[]> {
  const prompts: Record<string, string> = {
    day: CACHE_Q_DAY, week: CACHE_Q_WEEK, month: CACHE_Q_MONTH,
    quarter: CACHE_Q_QUARTER, year: CACHE_Q_YEAR,
  };
  if (refs.length === 0) return [];
  log(`${prefix}  Rebuilding ${refs.length} ${level} cache${refs.length > 1 ? "s" : ""}`);

  const failed: string[] = [];

  // One rebuild attempt. Returns null on success, else why it failed.
  const attempt = async (ref: string): Promise<string | null> => {
    const summary = await recall(ref, prompts[level], null);
    if (summary && !summary.startsWith("[recall:")) {
      writeCacheWithProvenance(level, ref, summary as string, { lineageIndex: activeLineageIndex ?? undefined });
      return null;
    }
    return `cache rebuild returned no usable summary for ${level} ${ref}`;
  };

  const rebuild = async (ref: string) => {
    // Retries apply only where a caller depends on completeness. Live-mode
    // cascades run constantly and self-heal via validateCaches, so paying for
    // repeat LLM calls there would be waste.
    const attempts = strict ? REBUILD_ATTEMPTS : 1;
    const problem = await withRetries((n) => attempt(ref), {
      attempts,
      onAttempt: ({ attempt: n, problem, final }) => {
        if (problem === null) {
          log(`${prefix}    ${ref} ✓${n > 1 ? ` (attempt ${n})` : ""}`);
          return;
        }
        log(`${prefix}    ${ref} ✗ ${problem}${final ? "" : ` — retrying (${n}/${attempts - 1})`}`);
      },
    });
    if (problem !== null) failed.push(ref);
  };

  if (["day", "week", "month"].includes(level)) await Promise.all(refs.map(rebuild));
  else for (const ref of refs) await rebuild(ref);

  return failed;
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
    if (!dayCacheMtime || latestEpisodeMtime > dayCacheMtime || cacheManifestNeedsRefresh("day", day, latestEpisodeMtime, { lineageIndex: activeLineageIndex ?? undefined })) staleDays.push(day);
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
    const newest = Math.max(...days.map(d => mtime(cachePath("day", d))));
    if (newest > wt || cacheManifestNeedsRefresh("week", week, newest, { lineageIndex: activeLineageIndex ?? undefined })) staleWeeks.push(week);
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
    const newest = Math.max(...weeks.map(w => mtime(cachePath("week", w))));
    if (newest > mt || cacheManifestNeedsRefresh("month", month, newest, { lineageIndex: activeLineageIndex ?? undefined })) staleMonths.push(month);
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
    const newest = Math.max(...months.map(m => mtime(cachePath("month", m))));
    if (newest > qt || cacheManifestNeedsRefresh("quarter", quarter, newest, { lineageIndex: activeLineageIndex ?? undefined })) staleQuarters.push(quarter);
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
    const newest = Math.max(...quarters.map(q => mtime(cachePath("quarter", q))));
    if (newest > yt || cacheManifestNeedsRefresh("year", year, newest, { lineageIndex: activeLineageIndex ?? undefined })) staleYears.push(year);
  }
  if (staleYears.length) {
    for (const y of staleYears.sort()) await rebuildCache("year", [y], prefix);
  }
}

// Derive unique refs at each level from a set of dates, rebuild bottom-up.
// `from` controls the starting level: "day" | "week" | "month" | "quarter" | "year".
// Pure decision lives in cascade-decision.ts; this wrapper does the IO.
// Returns the refs that failed, keyed by level. An empty object means the whole
// cascade succeeded. Failures no longer abort the remaining levels: a stale
// higher tier is repaired by re-running the failed date, which cascades upward
// again, whereas aborting leaves every untouched level stale with no record of
// what still needs doing.
async function batchCascade(
  dates: Set<string>,
  from: string = "day",
  prefix: string = "",
  strict: boolean = false,
): Promise<Partial<Record<CascadeLevel, string[]>>> {
  const decision = decideCascade(dates, from as CascadeLevel);
  const failures: Partial<Record<CascadeLevel, string[]>> = {};
  for (const level of ["day", "week", "month", "quarter", "year"] as CascadeLevel[]) {
    const refs = decision[level];
    if (!refs.length) continue;
    const failed = await rebuildCache(level, refs, prefix, strict);
    if (failed.length) failures[level] = failed;
  }
  return failures;
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
  // Fresh-machine fix (2026-06-09 VM onboarding test): on a brand-new install
  // the daemon starts before the user has ever launched pi, so the sessions
  // dir doesn't exist yet. The old existsSync guard silently skipped the
  // watcher and no episode was ever generated until a daemon restart.
  // Create the dir instead — pi happily uses a pre-created sessions dir.
  mkdirSync(PI_SESSIONS_DIR, { recursive: true });
  log(`Watching: ${PI_SESSIONS_DIR}`);
  watch(PI_SESSIONS_DIR, { recursive: true }, (_, filename) => {
    if (!filename?.endsWith(".jsonl")) return;
    onSessionChange(join(PI_SESSIONS_DIR, filename));
  });
}

// Project-local Herdr children may live outside the global watched tree. Parent
// dependency records make them discoverable; this bounded reconciliation gives
// them the same episode pipeline without attempting unsafe dynamic fs.watch
// expansion. Flush/sweep also include them immediately.
function startExternalSessionReconciliation() {
  const reconcile = () => {
    try {
      const index = getSessionLineageIndex(metaAllSessions());
      const external = externalLineageSessionCandidates(index, PI_SESSIONS_DIR);
      const { stale } = findStaleSessions(external, EPISODES_DIR);
      for (const session of stale.slice(0, 32)) onSessionChange(session.path);
      if (stale.length > 32) log(`External reconciliation bounded: scheduled 32/${stale.length}`);
    } catch (err: any) {
      log(`External reconciliation failed: ${err.message?.slice(0, 120)}`);
    }
  };
  setTimeout(reconcile, 30_000);
  setInterval(reconcile, 10 * 60_000);
}

// ============================================================================
// SWEEP / REPROCESS
// ============================================================================

async function sweep() {
  log("Sweep starting...");
  globalThis._skipCascade = true;
  const index = getSessionLineageIndex(metaAllSessions());
  activeLineageIndex = index;
  const sessions = lineageSessionCandidates(index);
  let ok = 0, exists = 0, fail = 0;
  const CONCURRENCY = parseInt(process.env.REPROCESS_CONCURRENCY || "8");
  const touchedDays = new Set<string>();

  const { stale: todo, fresh } = findStaleSessions(sessions, EPISODES_DIR, { log });
  exists = fresh;
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
  // Version the sweep batch. No single triggering session → author date = now.
  commitDataRepo({
    message: `sweep ${new Date().toISOString().slice(0, 10)}: ${ok} episodes, ${touchedDays.size} days touched`,
  });
  activeLineageIndex = null;
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

// weekDates / monthDates / monthWeeks / quarterMonths / yearQuarters now come
// from src/date-ranges.ts, which does all of it in UTC. The local-time versions
// that used to live here shifted every date by a day at or east of UTC —
// `snorrio reprocess 2026-W35` under Europe/Stockholm regenerated Aug 23-29.

function rangeToDays(range: { type: string; ref: string }): string[] {
  switch (range.type) {
    case "day": return [range.ref];
    case "week": return weekDates(range.ref);
    case "month": return monthDates(range.ref);
    case "quarter": return quarterMonths(range.ref).flatMap(m => monthDates(m));
    case "year": return yearQuarters(range.ref).flatMap(q => quarterMonths(q).flatMap(m => monthDates(m)));
    default: return [];
  }
}

function dateOfSession(s: SessionInfo): string {
  const { start, end } = metaTimestamps(s.path);
  return toDateStr(end || start || new Date().toISOString());
}

function sessionsForDays(days: string[]) {
  const daySet = new Set(days);
  const sessions = lineageSessionCandidates(activeLineageIndex ?? getSessionLineageIndex(metaAllSessions()));
  const matched: SessionInfo[] = [];
  for (const s of sessions) {
    if (daySet.has(dateOfSession(s))) matched.push(s);
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
  activeLineageIndex = getSessionLineageIndex(metaAllSessions());

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
        const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");
        let ctx: SessionContext;
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

        const messages = [...sessionMessagesToLlm(ctx.messages), userMessage(EPISODE_PROMPT)];
        const result = await complete(messages, EPISODE_SYSTEM, null, "dmn");
        const text = getText(result);
        if (!text?.trim()) {
          log(`    ${s.id.slice(0, 8)} ✗ empty response (stopReason: ${result.stopReason})`);
          fail++; return;
        }

        const fm = buildFrontmatter("pi", s.path, end || start || new Date().toISOString(), s.id);
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
      : range.type === "month" ? monthWeeks(range.ref)
      : range.type === "quarter" ? quarterMonths(range.ref).flatMap(m => monthWeeks(m))
      : range.type === "year" ? yearQuarters(range.ref).flatMap(q => quarterMonths(q).flatMap(m => monthWeeks(m)))
      : [];
    await rebuildCache("week", [...new Set(weeks)].sort());
  }

  if (depthLevel <= 3 && rangeLevel >= 3) {
    const months = range.type === "month" ? [range.ref]
      : range.type === "quarter" ? quarterMonths(range.ref)
      : range.type === "year" ? yearQuarters(range.ref).flatMap(q => quarterMonths(q))
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

  // Version the reprocess batch. No single triggering session → author date = now.
  commitDataRepo({ message: `reprocess ${range.ref} from ${depth}` });

  activeLineageIndex = null;
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
    activeLineageIndex = getSessionLineageIndex(metaAllSessions());
    const pendingPaths = new Set<string>();
    for (const [filePath, timer] of timers.entries()) {
      clearTimeout(timer);
      timers.delete(filePath);
      pendingPaths.add(filePath);
    }
    // Reconcile against disk, not just in-memory timers: if the watcher missed
    // sessions (never installed, daemon restarted, events dropped), the timers
    // map lies. The filesystem is the source of truth — "all sessions up to
    // date" must be true by construction. (2026-06-09 VM onboarding finding #2)
    try {
      const { stale } = findStaleSessions(lineageSessionCandidates(activeLineageIndex), EPISODES_DIR);
      for (const s of stale) pendingPaths.add(s.path);
    } catch (err: any) {
      log(`Flush: disk reconciliation failed (${err.message?.slice(0, 100)}); proceeding with watcher-pending only`);
    }
    if (pendingPaths.size === 0) { activeLineageIndex = null; log("Flush: 0 sessions to process"); return; }
    log(`Flush: ${pendingPaths.size} pending`);

    // Phase 1: Generate episodes (skip cascade — we'll do it ourselves)
    globalThis._skipCascade = true;
    let processed = 0, failed = 0;
    let latestTs: string | null = null; // world-time of the latest triggering session
    const dates = new Set<string>();
    for (const filePath of pendingPaths) {
      if (inflight.has(filePath)) continue;
      inflight.add(filePath);
      try {
        const r = await generateEpisode(filePath);
        if (r) {
          processed++; dates.add(r.dateStr);
          if (!latestTs || r.timestamp > latestTs) latestTs = r.timestamp;
        }
        else { failed++; }
      } catch (err: any) { log(`Flush error: ${err.message}`); failed++; }
      finally { inflight.delete(filePath); }
    }
    globalThis._skipCascade = false;

    // Phase 2: Regenerate day caches (blocking — /done waits for this)
    for (const dateStr of dates) {
      try {
        log(`  Regenerating day cache: ${dateStr}`);
        const daySummary = await recall(dateStr, CACHE_Q_DAY, null);
        if (daySummary && !daySummary.startsWith("[recall:")) {
          writeCacheWithProvenance("day", dateStr, daySummary as string, { lineageIndex: activeLineageIndex ?? undefined });
        }
      } catch (err: any) { log(`  Day cache error: ${err.message?.slice(0, 100)}`); }
    }

    // Emit summary — /done stops waiting here
    log(`Flush: ${processed} processed, ${failed} failed`);

    // Phase 3: Background cascade — deduplicated
    (async () => {
      await batchCascade(dates as Set<string>, "week", "[bg]");
      // One commit for the whole flush batch: episodes (phase 1) + day caches
      // (phase 2) + cascaded caches (phase 3). Author date = world-time of the
      // latest triggering session in the batch.
      commitDataRepo({
        message: `cascade flush ${[...dates].sort().join(",")}: ${processed} episode${processed === 1 ? "" : "s"} → day/week/month/quarter/year`,
        authorDate: latestTs ?? undefined,
      });
      activeLineageIndex = null;
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
// PROVENANCE MIGRATION
// ============================================================================

async function migrateProvenanceCommand(dryRun: boolean) {
  if (dryRun) process.env.SNORRIO_LINEAGE_CACHE_READONLY = "1";
  log(`Provenance migration ${dryRun ? "dry-run" : "starting"}...`);
  const index = getSessionLineageIndex(metaAllSessions());
  activeLineageIndex = index;
  const result = migrateProvenanceMetadata({
    episodesDir: EPISODES_DIR,
    cacheDir: CACHE_DIR,
    lineageIndex: index,
    home: HOME,
    machine: MACHINE,
    dryRun,
  });
  const recascade = planProvenanceRecascade(result, { cacheDir: CACHE_DIR, episodesDir: EPISODES_DIR, lineageIndex: index });
  let failedDates: string[] = [];
  if (!dryRun) {
    if (recascade.dates.length > 0) {
      const failures = await batchCascade(new Set(recascade.dates), "day", "[migration]", true);
      failedDates = failures.day ?? [];
    }
    // Record a signature only for a date whose day cache actually rebuilt. A
    // second run then makes zero LLM calls for the settled dates while still
    // retrying the ones that failed; recording a failed date would mark it
    // permanently done and silently leave double-counted evidence in place.
    // Do not overwrite this marker with a differently shaped report.
    const settled = Object.fromEntries(
      Object.entries(recascade.signatures).filter(([date]) => !failedDates.includes(date)),
    );
    writeProvenanceRecascadeMarker(CACHE_DIR, settled);
  }
  log(`  Episodes: ${result.episodesScanned} scanned, ${result.episodesChanged} metadata changes, ${result.episodesUnknown} unknown`);
  log(`  Cache manifests: ${result.manifestsWritten}${dryRun ? " would be written" : " written"}`);
  log(`  Duplicate-evidence dates: ${result.affectedDates.length}; ${recascade.dates.length} require recascade`);

  if (!dryRun) {
    const rebuilt = recascade.dates.length - failedDates.length;
    commitDataRepo({ message: `migrate provenance: ${result.episodesChanged} episodes, ${result.manifestsWritten} manifests, ${rebuilt} dates recascaded` });
    if (failedDates.length) {
      log(`  INCOMPLETE: ${failedDates.length} date(s) failed to rebuild: ${failedDates.join(", ")}`);
      log("  Re-run `snorrio migrate-provenance` to retry only those dates.");
    }
  }
  activeLineageIndex = null;
  return { ...result, failedDates };
}

// ============================================================================
// LOCAL-DATE MIGRATION
// ============================================================================

// Stamp local_date/tz/utc_offset/tz_source onto historical episodes.
//
// Metadata only: no cascade, no LLM calls, no file moves, prose byte-identical.
// DRY RUN IS THE DEFAULT and writing requires --confirm, because on 2026-08-24 a
// mutating migration ran from an operator typing `--help` (an unrecognized flag
// was ignored rather than rejected, and the write path was the default). Here the
// safe path is the default and the destructive one has to be asked for by name.
async function migrateLocalDatesCommand(confirm: boolean) {
  log(`Local-date migration ${confirm ? "starting" : "dry-run (pass --confirm to write)"}...`);
  const result = migrateEpisodeLocalDates({ episodesDir: EPISODES_DIR, dryRun: !confirm });
  log(`  Episodes: ${result.episodesScanned} scanned, ${result.episodesChanged} ${confirm ? "stamped" : "would be stamped"}, ${result.episodesAlreadyStamped} already current`);
  if (result.skipped.length) {
    log(`  SKIPPED ${result.skipped.length} episode(s) that could not be stamped:`);
    for (const { path, reason } of result.skipped.slice(0, 20)) log(`    ${path}: ${reason}`);
  }
  if (confirm && result.episodesChanged > 0) {
    commitDataRepo({ message: `backfill local_date on ${result.episodesChanged} episodes (tz Etc/UTC, assumed)` });
  }
  return result;
}

// ============================================================================
// MAIN
// ============================================================================

async function main() {
  if (process.argv.includes("--migrate-provenance") || process.argv.includes("--add-frontmatter")) {
    // Reject unrecognized flags rather than defaulting to the writing path.
    // `--help` used to fall through here and run the real migration, because
    // dry-run was read as a second independent `includes()` check.
    const known = new Set(["--migrate-provenance", "--add-frontmatter", "--dry-run"]);
    const extra = process.argv.slice(2).filter((arg) => arg.startsWith("-") && !known.has(arg));
    if (extra.length) {
      console.error(`Unknown flag for --migrate-provenance: ${extra[0]}`);
      console.error("Accepted flags: --dry-run");
      process.exit(2);
    }
    await migrateProvenanceCommand(process.argv.includes("--dry-run"));
    process.exit(0);
  }
  if (process.argv.includes("--migrate-local-dates")) {
    // Unknown flags stop the command; they are never read as consent.
    const known = new Set(["--migrate-local-dates", "--confirm", "--dry-run"]);
    const extra = process.argv.slice(2).filter((arg) => arg.startsWith("-") && !known.has(arg));
    if (extra.length) {
      console.error(`Unknown flag for --migrate-local-dates: ${extra[0]}`);
      console.error("Accepted flags: --confirm, --dry-run");
      process.exit(2);
    }
    if (process.argv.includes("--confirm") && process.argv.includes("--dry-run")) {
      console.error("--confirm and --dry-run contradict each other; refusing to guess.");
      process.exit(2);
    }
    const result = await migrateLocalDatesCommand(process.argv.includes("--confirm"));
    process.exit(result.skipped.length ? 1 : 0);
  }
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
  const repo = ensureDataRepo();
  log(repo.enabled
    ? `Data repo ready: ${repo.root}`
    : "Data repo versioning DISABLED (git unavailable or init failed) — memory continues unversioned");
  startWatcher();
  startExternalSessionReconciliation();
  startFlushWatcher();
  scheduleSweep();
  log("Ready");

  process.on("SIGINT", () => { log("Shutdown"); process.exit(0); });
  process.on("SIGTERM", () => { log("Shutdown"); process.exit(0); });
}

main().catch(err => { log(`Fatal: ${err.message}`); process.exit(1); });
