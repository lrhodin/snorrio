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

import { readFileSync, readdirSync, existsSync, realpathSync } from "fs";
import { join } from "path";
import { pathToFileURL } from "url";
import { complete, stream as aiStream, getText, userMessage, SNORRIO_HOME, piRoot, getTimezone } from "./ai.ts";
import { sessionMessagesToLlm, type RawSessionMessage } from "./model-independence.ts";
import { resolveSession, sessionIdFromEntries, type SessionInfo } from "./session-meta.ts";
import { resolveShaAt, readFileAtSha } from "./versioned-read.ts";
import { getSessionLineageIndex, resolveLineageSession } from "./session-lineage.ts";
import { temporalRefs } from "./local-date.ts";
import { createZoneResolver, tzJournalPath } from "./tz-journal.ts";
import { monthWeeks, quarterMonths, weekDates, yearQuarters } from "./date-ranges.ts";
import { ensureCacheProvenanceManifest, writeCacheWithProvenance, type CacheLevel, type CacheProvenanceManifest } from "./cache-provenance.ts";
import { prepareTemporalNarrativeSource, TEMPORAL_NARRATIVE_INSTRUCTIONS } from "./temporal-narrative.ts";

const HOME = process.env.HOME!;
const PI_SESSIONS_DIR = join(HOME, ".pi/agent/sessions");
const EPISODES_DIR = join(SNORRIO_HOME, "episodes");
const CACHE_DIR = join(SNORRIO_HOME, "cache");

// Minimal local description of pi's session-manager surface. pi is a dynamic,
// optional dependency loaded from the *global* install at runtime, so we do NOT
// depend on its published types (mirrors ai.ts treating pi-ai as `any`). Describe
// only what snorrio touches. Messages come in as RawSessionMessage (loose: pi
// control entries carry no content); sessionMessagesToLlm() narrows them to
// strict, content-bearing Message[] at the read boundary before complete().
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

// Which zone a PAST instant belongs to, from the journal. The whole point of
// this function is "what was happening when this session ran", so asking today's
// zone where a July session's day boundary fell would load the wrong day cache
// for any session recorded in a different era.
const resolveZoneFor = createZoneResolver({
  path: tzJournalPath(SNORRIO_HOME),
  fallbackZone: getTimezone,
  onError: (message) => process.stderr.write(`[snorrio:recall] WARNING: ${message}\n`),
});

function loadTemporalContext(timestamp: Date): string {
  // Shared Intl-based resolution (src/local-date.ts). Was a format-then-reparse
  // round-trip through toLocaleString("en-US") plus its own ISO week formula,
  // which disagreed with cascade-decision.ts dateToWeek() in 53-week years and
  // so could load a neighbouring week's cache as "that week".
  const { today, week, month, quarter, year } = temporalRefs(timestamp, resolveZoneFor(timestamp).tz);

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

async function recallPiSession(sessionFile: string, question: string, modelSpec: string | null, options: { context?: boolean; onChunk?: OnChunk } = {}) {
  const { loadEntriesFromFile, buildSessionContext } = await getPiSessionManager();

  const entries = loadEntriesFromFile(sessionFile);
  // loadEntriesFromFile returns FileEntry[] (includes the session header);
  // dropping the "session" entry narrows to SessionEntry[] for buildSessionContext.
  const sessionEntries = entries.filter((e): e is SessionEntry => e.type !== "session");
  if (sessionEntries.length === 0) return "[recall: session has no entries]";

  let ctx: SessionContext;
  try { ctx = buildSessionContext(sessionEntries); }
  catch (err: any) { return `[recall: failed to build context — ${err.message?.slice(0, 200)}]`; }

  if (!ctx.messages.length) return "[recall: session has no messages]";

  let temporalCtx = "";
  if (options.context) {
    const ts = extractTimestamp(sessionFile);
    if (ts) temporalCtx = loadTemporalContext(ts);
  }

  // Make session-level recall model-independent: convert thinking blocks to
  // readable text rather than stripping them, so any reader model can read any
  // session faithfully without tripping Anthropic's thinking-signature replay
  // 400. See src/model-independence.ts for the rationale.
  const readableMessages = sessionMessagesToLlm(ctx.messages);

  const systemPrompt = RECALL_SYSTEM + temporalCtx;
  const q = question + "\n\nRespond in plain text. Do not call any tools.";

  return apiCallStream([...readableMessages, userMessage(q)], systemPrompt, modelSpec, options.onChunk);
}

function recallSession(ref: string, question: string, modelSpec: string | null, options: { context?: boolean; onChunk?: OnChunk } = {}) {
  // Direct .jsonl path
  if (ref.endsWith(".jsonl")) {
    if (!existsSync(ref)) return `[recall: file not found — ${ref}]`;
    return recallPiSession(ref, question, modelSpec, options);
  }

  // UUID lookup. Be specific about WHY a ref failed: a bare "not found" made a
  // reader conclude a correctly-reported id had been hallucinated, when in fact
  // the resolver was blind to it (see the 2026-07-29 write/read id asymmetry).
  const baseResolution = resolveSession(ref);
  const resolution = !baseResolution.ok && baseResolution.reason === "not_found"
    ? resolveLineageSession(ref)
    : baseResolution;
  if (!resolution.ok) {
    if (resolution.reason === "ambiguous") {
      const shown = resolution.matches.slice(0, 8).map((m) => m.id);
      const more = resolution.matches.length - shown.length;
      return (
        `[recall: ambiguous session ref "${ref}" — matches ${resolution.matches.length} sessions. ` +
        `Use a longer prefix. e.g. ${shown.join(", ")}${more > 0 ? `, +${more} more` : ""}]`
      );
    }
    return (
      `[recall: no session on disk whose id starts with "${ref}". ` +
      `Session ids are read from each file's header, not its filename, so a ref that ` +
      `looks right may simply not exist — check ~/.pi/agent/sessions/ before assuming ` +
      `an episode cited a bad id.]`
    );
  }

  return recallPiSession(resolution.session.path, question, modelSpec, options);
}

// ============================================================================
// DAY RECALL — load all episodes as context
// ============================================================================

// sessionId -> "YYYY-MM-DD HH:MM" start time, used to sort a day's episodes.
// Episodes are named by CANONICAL id (from each session's header), but the
// filename often carries a different token entirely, so index under both:
// filename token for a pasted-fragment lookup, canonical id for episode names.
// Indexing only the filename token — the pre-2026-07-29 behaviour — silently
// missed every 4-part-named session (194 of 299 here), sending them down the
// header-parse fallback below.
function buildSessionIndex() {
  const index = new Map<string, string>();
  (function walk(dir: string) {
    try {
      for (const d of readdirSync(dir, { withFileTypes: true })) {
        const p = join(dir, d.name);
        if (d.isDirectory()) { walk(p); continue; }
        if (!d.name.endsWith(".jsonl")) continue;
        const m = d.name.match(/^(\d{4}-\d{2}-\d{2})T(\d{2})-(\d{2})-\d{2}-\d{3}Z_(.+)\.jsonl$/);
        if (!m) continue;
        const started = `${m[1]} ${m[2]}:${m[3]}`;
        index.set(m[4], started);
        const canonical = sessionIdFromEntries(p);
        if (canonical) index.set(canonical, started);
      }
    } catch {}
  })(PI_SESSIONS_DIR);
  return index;
}

export interface LoadedEpisode {
  sessionId: string;
  sortKey: string;
  content: string;
  provenanceFamilyId: string;
  rootSessionId: string;
  parentSessionId: string | null;
  lineageComplete: boolean;
  lineageConflict: boolean;
  lineageSource: string;
}

export interface ProvenanceFamily {
  provenanceFamilyId: string;
  episodes: LoadedEpisode[];
  sortKey: string;
}

function frontmatterValue(content: string, key: string): string | null {
  if (!content.startsWith("---\n")) return null;
  const end = content.indexOf("\n---\n", 4);
  if (end < 0) return null;
  const match = content.slice(4, end).match(new RegExp(`^${key}:\\s*(.+)$`, "m"));
  if (!match) return null;
  const raw = match[1].trim();
  if (raw === "null") return null;
  if (raw.startsWith('"')) {
    try { return JSON.parse(raw); } catch { return null; }
  }
  return raw;
}

function loadEpisodes(dateStr: string): LoadedEpisode[] {
  const dir = join(EPISODES_DIR, dateStr);
  if (!existsSync(dir)) return [];

  const files = readdirSync(dir).filter(f => f.endsWith(".md"));
  if (!files.length) return [];

  const sessionIndex = buildSessionIndex();
  const lineageIndex = getSessionLineageIndex();
  const episodes: LoadedEpisode[] = [];

  for (const file of files) {
    const content = readFileSync(join(dir, file), "utf8").trim();
    const fileSessionId = file.replace(".md", "");
    const sessionId = frontmatterValue(content, "session_id") || fileSessionId;
    const indexed = lineageIndex.getById(sessionId);
    const metadataCurrent = frontmatterValue(content, "lineage_metadata_version") === "1";
    const hasStructuralEdge = indexed && indexed.lineageSource !== "none" && indexed.lineageSource !== "unknown";
    // Live structural edges supersede stale episode metadata (for example a
    // later resume consumer). Historical unlinked sessions retain their
    // migrated unknown/incomplete marker rather than being promoted to roots.
    const provenanceFamilyId = hasStructuralEdge
      ? indexed.provenanceFamilyId
      : frontmatterValue(content, "provenance_family_id") || indexed?.provenanceFamilyId || sessionId;
    const rootSessionId = hasStructuralEdge
      ? indexed.rootSessionId
      : frontmatterValue(content, "root_session_id") || indexed?.rootSessionId || sessionId;
    const parentSessionId = hasStructuralEdge
      ? indexed.parentSessionId
      : frontmatterValue(content, "parent_session_id") || indexed?.parentSessionId || null;
    const completeValue = frontmatterValue(content, "lineage_complete");
    const conflictValue = frontmatterValue(content, "lineage_conflict");
    const persistedSource = frontmatterValue(content, "lineage_source");
    const explicitComplete = completeValue === "true" ? true : completeValue === "false" ? false : null;
    const explicitConflict = conflictValue === "true" ? true : conflictValue === "false" ? false : null;
    // A legacy episode with no persisted lineage and no recoverable structural
    // edge is epistemically unknown. The presence of a standalone session file
    // does not prove that it was never a delegated child.
    const lineageComplete = hasStructuralEdge
      ? indexed.lineageComplete
      : metadataCurrent ? explicitComplete ?? false : false;
    const lineageConflict = hasStructuralEdge ? indexed.lineageConflict : explicitConflict ?? false;
    const lineageSource = hasStructuralEdge
      ? indexed.lineageSource
      : metadataCurrent ? persistedSource || "unknown" : "unknown";
    let sortKey = sessionIndex.get(sessionId);
    if (!sortKey) {
      // Capture start time (group 2) and optional end time (group 3).
      // Sort by start; end appended as natural string tiebreak.
      const headerMatch = content.match(/<!--\s*session:\s*\S+\s*\|\s*(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})(?:→(\d{2}:\d{2}))?\s*\|/);
      sortKey = headerMatch
        ? `${headerMatch[1]} ${headerMatch[2]}${headerMatch[3] ? "→" + headerMatch[3] : ""}`
        : `${dateStr} 00:00`;
    }
    episodes.push({ sessionId, sortKey, content, provenanceFamilyId, rootSessionId, parentSessionId, lineageComplete, lineageConflict, lineageSource });
  }

  episodes.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.sessionId.localeCompare(b.sessionId));
  return episodes;
}

export function groupEpisodesByProvenance(episodes: LoadedEpisode[]): ProvenanceFamily[] {
  const grouped = new Map<string, LoadedEpisode[]>();
  for (const episode of episodes) {
    const family = grouped.get(episode.provenanceFamilyId) ?? [];
    family.push(episode);
    grouped.set(episode.provenanceFamilyId, family);
  }
  return [...grouped].map(([provenanceFamilyId, familyEpisodes]) => {
    familyEpisodes.sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.sessionId.localeCompare(b.sessionId));
    return { provenanceFamilyId, episodes: familyEpisodes, sortKey: familyEpisodes[0].sortKey };
  }).sort((a, b) => a.sortKey.localeCompare(b.sortKey) || a.provenanceFamilyId.localeCompare(b.provenanceFamilyId));
}

export function formatDayEvidenceContext(episodes: LoadedEpisode[]): string {
  const families = groupEpisodesByProvenance(episodes);
  return families.map((family, familyIndex) => {
    // Group boundaries carry the only model-visible provenance signal. IDs,
    // completeness diagnostics, frontmatter, and timestamps are deliberately
    // absent: they are machinery, not part of the day being remembered.
    const bodies = family.episodes.map((episode) =>
      prepareTemporalNarrativeSource(episode.content)
    ).join("\n\n");
    return `--- Internal source group ${familyIndex + 1} ---\n${bodies}`;
  }).join("\n\n");
}

export const PROVENANCE_SYNTHESIS_INSTRUCTIONS = `Provenance metadata is private reasoning context. Use provenance_family_id only to avoid double-counting repeated accounts inside one connected family. Distinct family IDs mean only that no structural relationship is recorded; they do not prove independent corroboration.${TEMPORAL_NARRATIVE_INSTRUCTIONS}`;

type MissingManifest = { schemaVersion: 0; level: CacheLevel; ref: string; missing: true };

function opaqueSourceGroups(
  manifest: CacheProvenanceManifest | MissingManifest,
  aliases: Map<string, string>,
): string {
  const families = "families" in manifest ? manifest.families : [];
  return families.map((family) => {
    let alias = aliases.get(family.provenanceFamilyId);
    if (!alias) {
      alias = `S${aliases.size + 1}`;
      aliases.set(family.provenanceFamilyId, alias);
    }
    return alias;
  }).join(", ");
}

function childManifest(level: CacheLevel, ref: string, atSha?: string | null): CacheProvenanceManifest | MissingManifest {
  if (atSha) {
    const raw = readFileAtSha(atSha, `cache/${level === "day" ? "days" : level === "week" ? "weeks" : level === "month" ? "months" : level === "quarter" ? "quarters" : "years"}/${ref}.provenance.json`);
    if (raw) {
      try { return JSON.parse(raw) as CacheProvenanceManifest; } catch {}
    }
    return { schemaVersion: 0, level, ref, missing: true };
  }
  return ensureCacheProvenanceManifest(level, ref);
}

function recallDay(dateStr: string, question: string, modelSpec: string | null, onChunk?: OnChunk) {
  const episodes = loadEpisodes(dateStr);
  if (episodes.length === 0) return `[recall: no episodes found for ${dateStr}]`;

  const context = formatDayEvidenceContext(episodes);

  const systemPrompt = `You are a recall agent for ${dateStr}. Your context contains every episode from that day, ordered into provenance families. Parent and descendant sessions remain fully visible but each family is one evidence source.

${PROVENANCE_SYNTHESIS_INSTRUCTIONS}

Be precise about the work, decisions, reasoning, and commitments. If the context lacks a fact, state the factual gap without discussing source mechanics.`;

  const messages = [userMessage(`Question: ${question}\n\n---\n\nContext (episode summaries for ${dateStr}):\n\n${context}`)];
  return apiCallStream(messages, systemPrompt, modelSpec, onChunk);
}

// ============================================================================
// WEEK RECALL — load day summaries as context
// ============================================================================

// weekDates / monthWeeks / quarterMonths / yearQuarters live in
// src/date-ranges.ts and do all arithmetic in UTC. The versions that used to be
// defined here built dates with local-time constructors and read them back with
// toISOString(), so at or east of UTC every date shifted by one day: under
// Europe/Stockholm, `recall 2026-W35` loaded Aug 23-29 instead of Aug 24-30.

async function recallWeek(weekStr: string, question: string, modelSpec: string | null, onChunk?: OnChunk, atSha?: string | null) {
  const dates = weekDates(weekStr);
  const daySummaries: Array<{ date: string; episodeCount: number; summary: string; manifest: ReturnType<typeof childManifest> }> = [];

  for (const dateStr of dates) {
    const episodes = loadEpisodes(dateStr);
    if (episodes.length === 0) continue;

    const cachePath = join(CACHE_DIR, "days", `${dateStr}.md`);
    let summary: string;

    if (atSha) {
      // Versioned read (--at): the day cache as it existed at the resolved
      // commit. Absent at that commit ⇒ skip the day — never regenerate from
      // live data, never write back (the contemporaneous view stays faithful
      // and the live cache stays unpoisoned).
      const past = readFileAtSha(atSha, `cache/days/${dateStr}.md`);
      if (past === null) continue;
      summary = past.trim();
    } else if (existsSync(cachePath)) {
      summary = readFileSync(cachePath, "utf8").trim();
    } else {
      summary = await recallDay(dateStr, "Write the narrative of this day. Not a checklist — an account of what happened, what was worked on, what got decided, what changed, and why. Track commitments made for today but don't carry weekly or longer-term goals — mention them naturally so higher temporal levels can pick them up. Include session IDs so any thread can be traced back to its source session.", modelSpec) as string;
      if (summary && !summary.startsWith("[recall:")) {
        writeCacheWithProvenance("day", dateStr, summary);
      }
    }

    daySummaries.push({ date: dateStr, episodeCount: episodes.length, summary, manifest: childManifest("day", dateStr, atSha) });
  }

  if (daySummaries.length === 0) return `[recall: no data found for ${weekStr}]`;

  const sourceAliases = new Map<string, string>();
  const context = daySummaries.map(d =>
    `--- ${d.date} ---\nINTERNAL_SOURCE_GROUPS ${opaqueSourceGroups(d.manifest, sourceAliases)}\n${d.summary}`
  ).join("\n\n");

  const systemPrompt = `You are a recall agent for week ${weekStr}. Your context is day-level summaries for each day that had activity. Each summary covers all sessions from that day.

${PROVENANCE_SYNTHESIS_INSTRUCTIONS}

You operate at week resolution. Preserve the developing threads and trajectory without exposing the memory hierarchy or its source mechanics.`;

  const messages = [userMessage(`Question: ${question}\n\n---\n\nContext (day summaries for ${weekStr}):\n\n${context}`)];
  return apiCallStream(messages, systemPrompt, modelSpec, onChunk);
}

// ============================================================================
// MONTH RECALL — load week summaries as context
// ============================================================================

function weekHasData(weekStr: string) {
  const dates = weekDates(weekStr);
  return dates.some(d => loadEpisodes(d).length > 0);
}

async function recallMonth(monthStr: string, question: string, modelSpec: string | null, onChunk?: OnChunk, atSha?: string | null) {
  const weeks = monthWeeks(monthStr);
  const weekSummaries: Array<{ week: string; activeDays: number; summary: string; manifest: ReturnType<typeof childManifest> }> = [];

  for (const weekStr of weeks) {
    if (!weekHasData(weekStr)) continue;

    const cachePath = join(CACHE_DIR, "weeks", `${weekStr}.md`);
    let summary: string;

    if (atSha) {
      // Versioned read (--at) — see recallWeek for the contract.
      const past = readFileAtSha(atSha, `cache/weeks/${weekStr}.md`);
      if (past === null) continue;
      summary = past.trim();
    } else if (existsSync(cachePath)) {
      summary = readFileSync(cachePath, "utf8").trim();
    } else {
      summary = await recallWeek(weekStr, "Write the narrative of this week. Not a checklist — an essay that identifies the main threads, arc, and trajectory. What's developing across multiple days? What started, what stalled, what shifted? Operate at week resolution — don't repeat daily details, surface the patterns that are only visible across days. Reference specific dates so the reader can drill down.", modelSpec) as string;
      if (summary && !summary.startsWith("[recall:")) {
        writeCacheWithProvenance("week", weekStr, summary);
      }
    }

    const dates = weekDates(weekStr);
    const activeDays = dates.filter(d => loadEpisodes(d).length > 0).length;
    weekSummaries.push({ week: weekStr, activeDays, summary, manifest: childManifest("week", weekStr, atSha) });
  }

  if (weekSummaries.length === 0) return `[recall: no data found for ${monthStr}]`;

  const sourceAliases = new Map<string, string>();
  const context = weekSummaries.map(w =>
    `--- ${w.week} ---\nINTERNAL_SOURCE_GROUPS ${opaqueSourceGroups(w.manifest, sourceAliases)}\n${w.summary}`
  ).join("\n\n");

  const systemPrompt = `You are a recall agent for ${monthStr}. Your context is week-level summaries for each week that had activity.

${PROVENANCE_SYNTHESIS_INSTRUCTIONS}

You operate at month resolution. Preserve shifts, themes, and direction without exposing the memory hierarchy or its source mechanics.`;

  const messages = [userMessage(`Question: ${question}\n\n---\n\nContext (week summaries for ${monthStr}):\n\n${context}`)];
  return apiCallStream(messages, systemPrompt, modelSpec, onChunk);
}

// ============================================================================
// QUARTER RECALL — load month summaries as context
// ============================================================================

function monthHasData(monthStr: string) {
  const weeks = monthWeeks(monthStr);
  return weeks.some(w => weekHasData(w));
}

async function recallQuarter(quarterStr: string, question: string, modelSpec: string | null, onChunk?: OnChunk, atSha?: string | null) {
  const months = quarterMonths(quarterStr);
  const monthSummaries: Array<{ month: string; summary: string; manifest: ReturnType<typeof childManifest> }> = [];

  for (const monthStr of months) {
    if (!monthHasData(monthStr)) continue;

    const cachePath = join(CACHE_DIR, "months", `${monthStr}.md`);
    let summary: string;

    if (atSha) {
      // Versioned read (--at) — see recallWeek for the contract.
      const past = readFileAtSha(atSha, `cache/months/${monthStr}.md`);
      if (past === null) continue;
      summary = past.trim();
    } else if (existsSync(cachePath)) {
      summary = readFileSync(cachePath, "utf8").trim();
    } else {
      summary = await recallMonth(monthStr, "Write the narrative of this month. Identify the trajectory — what emerged, what shifted, what's building. Cover key decisions, what shipped, and the personal arc. Operate at month resolution — don't repeat weekly details, surface what's visible across weeks. Reference specific weeks so the reader can drill down.", modelSpec) as string;
      if (summary && !summary.startsWith("[recall:")) {
        writeCacheWithProvenance("month", monthStr, summary);
      }
    }

    monthSummaries.push({ month: monthStr, summary, manifest: childManifest("month", monthStr, atSha) });
  }

  if (monthSummaries.length === 0) return `[recall: no data found for ${quarterStr}]`;

  const sourceAliases = new Map<string, string>();
  const context = monthSummaries.map(m =>
    `--- ${m.month} ---\nINTERNAL_SOURCE_GROUPS ${opaqueSourceGroups(m.manifest, sourceAliases)}\n${m.summary}`
  ).join("\n\n");

  const systemPrompt = `You are a recall agent for ${quarterStr}. Your context is month-level summaries for each month that had activity.

${PROVENANCE_SYNTHESIS_INSTRUCTIONS}

You operate at quarter resolution. Surface patterns, trajectories, and emergent themes without exposing the memory hierarchy or its source mechanics.`;

  const messages = [userMessage(`Question: ${question}\n\n---\n\nContext (month summaries for ${quarterStr}):\n\n${context}`)];
  const result = await apiCallStream(messages, systemPrompt, modelSpec, onChunk);

  // Never persist an answer derived from a historical (--at) view.
  if (atSha) return result;

  const cachePath = join(CACHE_DIR, "quarters", `${quarterStr}.md`);
  if (!existsSync(cachePath) && result && !result.startsWith("[recall:")) {
    writeCacheWithProvenance("quarter", quarterStr, result as string);
  }

  return result;
}

// ============================================================================
// YEAR RECALL — load quarter summaries as context
// ============================================================================

function quarterHasData(quarterStr: string) {
  const months = quarterMonths(quarterStr);
  return months.some(m => monthHasData(m));
}

async function recallYear(yearStr: string, question: string, modelSpec: string | null, onChunk?: OnChunk, atSha?: string | null) {
  const quarters = yearQuarters(yearStr);
  const quarterSummaries: Array<{ quarter: string; summary: string; manifest: ReturnType<typeof childManifest> }> = [];

  for (const quarterStr of quarters) {
    if (!quarterHasData(quarterStr)) continue;

    const cachePath = join(CACHE_DIR, "quarters", `${quarterStr}.md`);
    let summary: string;

    if (atSha) {
      // Versioned read (--at) — see recallWeek for the contract.
      const past = readFileAtSha(atSha, `cache/quarters/${quarterStr}.md`);
      if (past === null) continue;
      summary = past.trim();
    } else if (existsSync(cachePath)) {
      summary = readFileSync(cachePath, "utf8").trim();
    } else {
      summary = await recallQuarter(quarterStr, "Write a narrative of this quarter. What's the arc — what materialized that wasn't there at the start, what's building? Don't restate monthly details — just what's visible from this altitude. Reference specific months so the reader can drill down.", modelSpec) as string;
      if (summary && !summary.startsWith("[recall:")) {
        writeCacheWithProvenance("quarter", quarterStr, summary);
      }
    }

    quarterSummaries.push({ quarter: quarterStr, summary, manifest: childManifest("quarter", quarterStr, atSha) });
  }

  if (quarterSummaries.length === 0) return `[recall: no data found for ${yearStr}]`;

  const sourceAliases = new Map<string, string>();
  const context = quarterSummaries.map(q =>
    `--- ${q.quarter} ---\nINTERNAL_SOURCE_GROUPS ${opaqueSourceGroups(q.manifest, sourceAliases)}\n${q.summary}`
  ).join("\n\n");

  const systemPrompt = `You are a recall agent for ${yearStr}. Your context is quarter-level summaries for each quarter that had activity.

${PROVENANCE_SYNTHESIS_INSTRUCTIONS}

You operate at year resolution. Carry every real thread forward, preserve unresolved outcomes, and surface arcs and transformations without exposing the memory hierarchy or its source mechanics.`;

  const messages = [userMessage(`Question: ${question}\n\n---\n\nContext (quarter summaries for ${yearStr}):\n\n${context}`)];
  const result = await apiCallStream(messages, systemPrompt, modelSpec, onChunk);

  // Never persist an answer derived from a historical (--at) view.
  if (atSha) return result;

  const cachePath = join(CACHE_DIR, "years", `${yearStr}.md`);
  if (!existsSync(cachePath) && result && !result.startsWith("[recall:")) {
    writeCacheWithProvenance("year", yearStr, result as string);
  }

  return result;
}

// ============================================================================
// API CALL — routes through unified complete()/stream()
// ============================================================================

type OnChunk = (accumulated: string) => void;

// CLI-only streaming state. Set by main() exclusively; programmatic callers
// (e.g. the episode daemon) leave these unset so apiCallStream stays a pure
// text pump for them — no abort wiring, no stderr liveness writes.
let _cliAbortSignal: AbortSignal | undefined;
let _cliEmitThinking = false;

// Test seam: lets tests substitute the non-streamed LLM boundary without a
// network call (e.g. simulate a 429/overloaded sub-summary). Production never
// calls the setter, so the default binding (`complete`) is always in effect.
let _complete: typeof complete = complete;
export function __setCompleteForTest(fn: typeof complete | null): void {
  _complete = fn ?? complete;
}

async function apiCall(messages: any[], systemPrompt: string, modelSpec: string | null) {
  const result = await _complete(messages, systemPrompt, modelSpec);

  if (result.stopReason === "error") {
    const errMsg = result.errorMessage || "unknown API error";
    const match = errMsg.match(/"message":"([^"]+)"/);
    return `[recall: API error — ${match ? match[1] : errMsg.slice(0, 200)}]`;
  }

  return getText(result);
}

async function apiCallStream(messages: any[], systemPrompt: string, modelSpec: string | null, onChunk?: OnChunk) {
  if (!onChunk) return apiCall(messages, systemPrompt, modelSpec);

  // Pass the CLI abort signal through to pi-ai so SIGINT cancels the in-flight
  // HTTP request rather than just abandoning the loop.
  const options = _cliAbortSignal ? { signal: _cliAbortSignal } : {};
  const eventStream = aiStream(messages, systemPrompt, modelSpec, null, options);
  let accumulated = "";
  let thinkingOpen = false;

  const closeThinking = () => {
    if (thinkingOpen) { process.stderr.write("\n"); thinkingOpen = false; }
  };

  try {
    for await (const event of eventStream) {
      if (event.type === "text_delta") {
        closeThinking();
        accumulated += event.delta;
        onChunk(accumulated);
      } else if (event.type === "thinking_delta" && _cliEmitThinking) {
        // Liveness only. stdout stays answer-text-only; the thinking pulse goes
        // to stderr so a long opus pre-text phase doesn't look like a hang.
        if (!thinkingOpen) { process.stderr.write("[recall: thinking"); thinkingOpen = true; }
        process.stderr.write(".");
      } else if (event.type === "error") {
        closeThinking();
        // pi-ai runs maxRetries:0 — an overloaded/429 terminates the stream with
        // an `error` event. Surface it as a hard-fail marker (no retries).
        if (event.reason === "aborted") return "[recall: aborted]";
        const errMsg = event.error?.errorMessage || "unknown API error";
        const match = errMsg.match(/"message":"([^"]+)"/);
        return `[recall: API error — ${match ? match[1] : errMsg.slice(0, 200)}]`;
      }
    }
  } catch (err: any) {
    closeThinking();
    // Abort surfaces as a throw on some providers; treat it as a clean stop and
    // keep whatever already streamed to stdout.
    if (_cliAbortSignal?.aborted || err?.name === "AbortError") return "[recall: aborted]";
    const msg = err?.message || String(err);
    return `[recall: API error — ${msg.slice(0, 200)}]`;
  }

  return accumulated || "[recall: empty response from API]";
}

// ============================================================================
// PUBLIC API
// ============================================================================

export async function recall(ref: string, question: string, modelSpec: string | null = null, options: { context?: boolean; onChunk?: OnChunk; at?: string } = {}) {
  const type = refType(ref);
  const { onChunk } = options;

  // --at <ISO>: read caches as they existed at that wall-clock time, via the
  // data repo (content-addressed `git show`, never checkout). Resolve the
  // commit ONCE here so every cache read in the recall sees one consistent
  // snapshot.
  let atSha: string | null = null;
  if (options.at) {
    if (type === "session" || type === "day") {
      return `[recall: --at is only supported for cache-backed refs (week/month/quarter/year) — ${type} refs read ${type === "day" ? "episodes" : "the raw session"} directly]`;
    }
    const t = new Date(options.at);
    if (isNaN(t.getTime())) return `[recall: invalid --at timestamp — ${options.at}]`;
    try {
      atSha = resolveShaAt(t.toISOString());
    } catch (err: any) {
      return `[recall: versioned read unavailable — ${err.message}]`;
    }
    if (!atSha) return `[recall: no commit in data repo before ${t.toISOString()} — history starts later]`;
  }

  if (type === "day") return recallDay(ref, question, modelSpec, onChunk);
  if (type === "week") return recallWeek(ref, question, modelSpec, onChunk, atSha);
  if (type === "month") return recallMonth(ref, question, modelSpec, onChunk, atSha);
  if (type === "quarter") return recallQuarter(ref, question, modelSpec, onChunk, atSha);
  if (type === "year") return recallYear(ref, question, modelSpec, onChunk, atSha);

  // Session
  return recallSession(ref, question, modelSpec, { context: options.context, onChunk });
}

// Expose for episode daemon
export { loadEpisodes, weekDates, monthWeeks, quarterMonths, yearQuarters, weekHasData, monthHasData, quarterHasData };

// ============================================================================
// CLI
// ============================================================================

// Only run CLI when this file is the script entrypoint. The previous
// substring guard fired on any argv[1] containing "recall", including test
// files that import this module.
// argv[1] may be a symlink (e.g. ~/.local/bin/recall) while import.meta.url is
// always the resolved real path. Node resolves symlinks for import.meta.url but
// NOT for argv[1], so a direct === comparison is false under symlink invocation
// (which silently skipped the whole CLI -> recall produced zero output).
let isMain = false;
try {
  if (process.argv[1]) {
    isMain = import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
  }
} catch {
  isMain = false;
}
if (isMain) {
  const args = process.argv.slice(2);

  // No pin: null falls through resolveModel to the active pi model
  // (config.model, then pi's defaultProvider/defaultModel). See TODO.md for
  // making recall track the *session's own* model rather than the active one.
  let modelSpec: string | null = null;
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

  let at: string | undefined;
  const atIdx = args.indexOf("--at");
  if (atIdx !== -1) {
    if (!args[atIdx + 1]) {
      console.error("recall: --at requires an ISO timestamp argument");
      process.exit(1);
    }
    at = args[atIdx + 1];
    args.splice(atIdx, 2);
  }

  if (args.length < 2) {
    console.error("Usage: recall [--model <model>] [--context] [--at <ISO-timestamp>] <ref> \"question\"");
    console.error("  ref: session UUID, .jsonl path, YYYY-MM-DD (day), YYYY-Www (week), YYYY-MM (month), YYYY-QN (quarter), YYYY (year)");
    console.error("  models: haiku, sonnet, opus, or provider/model-id (default: active pi model)");
    console.error("  --context: load temporal context from when the session ran (situated witness)");
    console.error("  --at: read caches as they existed at that time (week/month/quarter/year refs; needs the versioned data repo)");
    process.exit(1);
  }

  const ref = args[0];
  const question = args.slice(1).join(" ");

  // Stream the answer to stdout as it arrives. apiCallStream hands onChunk the
  // FULL accumulated string each call, not the delta — print only the newly
  // appended tail (tracked via `printed`) so we never double-print.
  let printed = 0;
  const onChunk = (accumulated: string) => {
    if (accumulated.length > printed) {
      process.stdout.write(accumulated.slice(printed));
      printed = accumulated.length;
    }
  };

  // Graceful interrupt: SIGINT/SIGTERM abort the in-flight request. Whatever
  // already streamed to stdout is preserved; the abort returns a marker that
  // is NOT re-printed (printed > 0 path) and is never cached.
  const abort = new AbortController();
  _cliAbortSignal = abort.signal;
  _cliEmitThinking = true;
  const onSignal = () => abort.abort();
  process.on("SIGINT", onSignal);
  process.on("SIGTERM", onSignal);

  try {
    const answer = await recall(ref, question, modelSpec, { context, onChunk, at });

    // Hard-fail on provider error (e.g. overload/429). Surface to stderr, exit
    // non-zero — mirrors the non-streaming apiCall() error contract.
    if (typeof answer === "string" && answer.startsWith("[recall: API error")) {
      process.stderr.write((printed > 0 ? "\n" : "") + answer + "\n");
      process.exit(1);
    }

    if (printed > 0) {
      // Content already streamed via onChunk — do NOT re-log `answer` (that's the
      // double-print trap). Just terminate the line.
      process.stdout.write("\n");
    } else {
      // Nothing streamed: an early marker (e.g. "[recall: no episodes…]"), an
      // aborted-before-text stop, or the non-streaming fallback. Print as-is.
      process.stdout.write(answer + "\n");
    }
  } catch (err: any) {
    process.stderr.write((printed > 0 ? "\n" : "") + `recall failed: ${err.message}\n`);
    process.exit(1);
  }
}
