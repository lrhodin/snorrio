// The timezone journal: an append-only record of where this machine has been.
//
// What this replaces: `config.timezone` (a single value) plus a fallback to the
// host zone. A single value answers "what zone are we in?" and then answers it
// for every instant that has ever existed — so moving the box to Pacific did not
// mean "from now on, Pacific", it meant "every timestamp ever recorded was
// always Pacific". That is what made a clock change destructive rather than
// cosmetic: the store's 629 episodes were written under Etc/UTC and a config
// flip silently reinterpreted all of them.
//
// A journal answers a different, answerable question: what zone was in effect AT
// AN INSTANT. Travel becomes a recorded transition instead of tracked state, so
// a July instant still resolves to July's zone in October, and a session lived
// in Stockholm renders in CEST forever, even when it is read from California.
//
// Deliberate constraints:
//   - IANA names only, never fixed offsets. "Europe/Stockholm" carries its own
//     DST rules and the tz database keeps them current; "+02:00" is a fact about
//     one instant that quietly becomes wrong twice a year. (Etc/GMT+5 and
//     friends are IANA names for fixed offsets and are allowed — they are
//     DST-free by definition, not by accident.)
//   - `from` is a UTC instant, and an entry is in effect from then until the
//     next entry. No end times: an era ends exactly where the next one starts,
//     so there is no gap or overlap to get wrong.
//   - Malformed, unsorted, or unknown-zone journals throw. A journal that
//     silently degrades to the host zone would reintroduce the original bug at
//     the exact moment we most need to notice it.
//   - Nothing here ever auto-appends from the system zone. See resolveZone()
//     and src/setup-checks.ts for why a nudge beats a write.

import { readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import type { TimezoneSource } from "./episode-frontmatter.ts";

export const TZ_JOURNAL_FILENAME = "tz-history.jsonl";

/**
 * The zone every episode in the store was recorded under before the journal
 * existed, and therefore the zone a freshly seeded journal must claim for its
 * first era.
 *
 * This has to equal src/local-date-migration.ts HISTORICAL_TZ: 629 episodes now
 * carry `tz: Etc/UTC` frozen in frontmatter, and a journal whose opening era
 * disagreed with them would make the same instant resolve two ways depending on
 * which record you read. tests/tz-journal.test.ts asserts the two constants
 * agree, so the pairing cannot drift silently.
 */
export const SEEDED_ERA_TZ = "Etc/UTC";
export const SEEDED_ERA_NOTE = "vdesk default; era reconstructed to match the local_date backfill";

export interface TzJournalEntry {
  /** UTC instant the zone took effect, as written: "2026-08-25T18:00:00Z". */
  from: string;
  /** Epoch millis of `from`. Derived, for comparison without reparsing. */
  instant: number;
  /** IANA zone name, e.g. "America/Los_Angeles". */
  tz: string;
  /** Optional human note; never interpreted. */
  note?: string;
}

export interface ResolvedZone {
  tz: string;
  /**
   * journal — an era covers this instant
   * assumed — the instant precedes the journal, so the earliest recorded era is
   *           extrapolated backwards (labelled, not disguised)
   * system  — no journal at all; the caller's fallback zone
   */
  source: TimezoneSource;
}

export function tzJournalPath(snorrioHome: string): string {
  return join(snorrioHome, "config", TZ_JOURNAL_FILENAME);
}

const ENTRY_KEYS = new Set(["from", "tz", "note"]);

/**
 * Is `tz` a zone this runtime can actually resolve, and an IANA name rather
 * than an offset?
 *
 * Validated through Intl instead of a bundled list, so the answer comes from the
 * same tz database that will do the formatting. Intl is more permissive than we
 * want — it accepts "+05:00" and "utc" — so the offset forms are rejected by
 * shape first.
 */
export function isValidZoneName(tz: unknown): tz is string {
  if (typeof tz !== "string" || tz.length === 0) return false;
  if (/^[+-]/.test(tz)) return false;                       // "+05:00"
  if (/^(?:GMT|UTC)[+-]/i.test(tz)) return false;           // "GMT+2"
  if (!/^[A-Za-z][A-Za-z0-9_+-]*(?:\/[A-Za-z0-9_+-]+)*$/.test(tz)) return false;
  try {
    new Intl.DateTimeFormat("en-CA", { timeZone: tz });
    return true;
  } catch {
    return false;
  }
}

/**
 * Do two zone names denote the same zone?
 *
 * Not string equality: the tz database is full of links, and Intl canonicalizes
 * them. `Etc/UTC` resolves to `UTC` and `US/Pacific` to `America/Los_Angeles`,
 * so a name comparison reports drift between two spellings of one zone — which
 * on this machine is not hypothetical: the journal's seeded era is `Etc/UTC`
 * while the host reports `UTC`. Comparing canonical forms answers the question
 * actually being asked ("is the machine somewhere else?") rather than "are these
 * strings the same?".
 */
export function sameZone(a: string, b: string): boolean {
  if (a === b) return true;
  try {
    return new Intl.DateTimeFormat("en-CA", { timeZone: a }).resolvedOptions().timeZone ===
      new Intl.DateTimeFormat("en-CA", { timeZone: b }).resolvedOptions().timeZone;
  } catch {
    return false;
  }
}

function parseInstant(from: unknown, where: string): number {
  if (typeof from !== "string" || !/Z$/.test(from)) {
    throw new Error(`${where}: "from" must be a UTC instant ending in Z, got ${JSON.stringify(from)}`);
  }
  const ms = Date.parse(from);
  if (Number.isNaN(ms)) throw new Error(`${where}: "from" is not a parseable instant: ${from}`);
  return ms;
}

/**
 * Parse and validate a whole journal. Throws on the first problem, naming the
 * line — a partially-trusted journal is worse than none.
 */
export function parseTzJournal(text: string, label = "tz journal"): TzJournalEntry[] {
  const entries: TzJournalEntry[] = [];
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;
    const where = `${label} line ${i + 1}`;
    let raw: any;
    try {
      raw = JSON.parse(line);
    } catch (err: any) {
      throw new Error(`${where}: not valid JSON (${err?.message ?? "parse failed"})`);
    }
    if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
      throw new Error(`${where}: expected a JSON object per line`);
    }
    const unknown = Object.keys(raw).filter((key) => !ENTRY_KEYS.has(key));
    if (unknown.length) {
      throw new Error(`${where}: unknown key(s) ${unknown.join(", ")}; accepted: from, tz, note`);
    }
    const instant = parseInstant(raw.from, where);
    if (!isValidZoneName(raw.tz)) {
      throw new Error(
        `${where}: "tz" must be an IANA zone name this runtime accepts (not a fixed offset), got ${JSON.stringify(raw.tz)}`,
      );
    }
    if (raw.note !== undefined && typeof raw.note !== "string") {
      throw new Error(`${where}: "note" must be a string when present`);
    }
    const previous = entries[entries.length - 1];
    if (previous && instant <= previous.instant) {
      throw new Error(
        `${where}: entries must be strictly ordered by "from"; ${raw.from} does not follow ${previous.from}`,
      );
    }
    entries.push({ from: raw.from, instant, tz: raw.tz, note: raw.note });
  }
  return entries;
}

/** Read and validate the journal. An absent file is an empty journal; a corrupt one throws. */
export function readTzJournal(path: string): TzJournalEntry[] {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (err: any) {
    if (err?.code === "ENOENT") return [];
    throw err;
  }
  return parseTzJournal(text, path);
}

/**
 * The era covering `instant`, or null when the instant precedes the journal.
 *
 * `from` is inclusive: an instant exactly at a transition belongs to the era
 * that starts there, so the two eras never both claim the same millisecond.
 */
export function zoneAt(entries: TzJournalEntry[], instant: Date | number): TzJournalEntry | null {
  const ms = instant instanceof Date ? instant.getTime() : instant;
  let found: TzJournalEntry | null = null;
  for (const entry of entries) {
    if (entry.instant > ms) break;
    found = entry;
  }
  return found;
}

/** The most recent entry — the zone in effect now. */
export function journalHead(entries: TzJournalEntry[]): TzJournalEntry | null {
  return entries.length ? entries[entries.length - 1] : null;
}

/**
 * Resolve an instant to a zone, with a labelled answer in all three cases.
 *
 * The interesting case is an instant BEFORE the first entry. Erroring would be
 * defensible but makes reading an old transcript fail rather than degrade, and
 * falling back to the CURRENT zone is precisely the defect the journal exists to
 * remove — it would render a June session in whatever zone the box is in today.
 * So the earliest recorded era is extended backwards and labelled `assumed`,
 * which is the same honest label the local_date backfill used for exactly this
 * reconstruction. `system` is reserved for having no journal at all.
 */
export function resolveZone(
  entries: TzJournalEntry[],
  instant: Date | number,
  fallbackZone: string,
): ResolvedZone {
  const era = zoneAt(entries, instant);
  if (era) return { tz: era.tz, source: "journal" };
  if (entries.length) return { tz: entries[0].tz, source: "assumed" };
  return { tz: fallbackZone, source: "system" };
}

/** Serialize one entry as its journal line (no trailing newline). */
export function formatTzEntry(entry: { from: string; tz: string; note?: string }): string {
  const record: Record<string, string> = { from: entry.from, tz: entry.tz };
  if (entry.note) record.note = entry.note;
  return JSON.stringify(record);
}

export type ZoneResolver = (instant: Date | number) => ResolvedZone;

export interface ZoneResolverOptions {
  /** Path to the journal. Re-read when it changes on disk. */
  path: string;
  /** Zone to use when there is no journal at all. Called lazily. */
  fallbackZone: () => string;
  /** Called once per distinct failure. Must not throw. */
  onError?: (message: string) => void;
}

/**
 * A per-instant resolver that notices journal edits without a restart.
 *
 * `const TZ = getTimezone()` at module load was itself a live bug: the daemon
 * has been running since before any of this existed and would never observe a
 * zone change until restarted. The journal is re-read whenever its mtime or size
 * changes, so `snorrio tz set` takes effect on the next episode.
 *
 * A corrupt journal is reported loudly (once) and then treated as absent for
 * resolution, because a daemon that stops forming memory over a bad config line
 * fails worse than one that keeps working under a labelled `system` zone. The
 * loudness lives in the CLI and setup checks; this path only has to not lie
 * about which source answered.
 */
export function createZoneResolver(options: ZoneResolverOptions): ZoneResolver {
  let entries: TzJournalEntry[] = [];
  let signature = "";
  let reported = "";

  const refresh = () => {
    let stamp = "absent";
    try {
      const stat = statSync(options.path);
      stamp = `${stat.mtimeMs}:${stat.size}`;
    } catch {
      // Absent is a valid state with a stable signature.
    }
    if (stamp === signature) return;
    signature = stamp;
    try {
      entries = readTzJournal(options.path);
    } catch (err: any) {
      entries = [];
      const message = `tz journal unreadable, falling back to the system zone: ${err?.message ?? err}`;
      if (options.onError && message !== reported) {
        reported = message;
        options.onError(message);
      }
    }
  };

  return (instant) => {
    refresh();
    return resolveZone(entries, instant, options.fallbackZone());
  };
}

export interface AppendResult {
  /** The journal after the operation. */
  entries: TzJournalEntry[];
  /** The line to append, or null when nothing should be written. */
  line: string | null;
  /** Set when the zone asked for is already in effect. */
  noop: boolean;
}

/**
 * Validate an append against the existing journal. Pure — the caller writes.
 *
 * Rejects a `from` at or before the head: the journal is append-only and
 * monotonic, and an out-of-order entry would silently reinterpret an era that
 * has already been used to bucket episodes. Setting the zone already in effect
 * is a no-op rather than a duplicate line, so re-running the command is safe.
 */
export function appendTzEntry(
  entries: TzJournalEntry[],
  candidate: { from: string; tz: string; note?: string },
): AppendResult {
  if (!isValidZoneName(candidate.tz)) {
    throw new Error(
      `${JSON.stringify(candidate.tz)} is not an IANA zone name this runtime accepts. ` +
      `Use a name like America/Los_Angeles or Europe/Stockholm — never a fixed offset.`,
    );
  }
  const instant = parseInstant(candidate.from, "tz entry");
  const head = journalHead(entries);
  if (head && instant <= head.instant) {
    throw new Error(
      `refusing to append ${candidate.from}: the journal head is already ${head.from} ` +
      `(${head.tz}) and the journal is append-only and monotonic.`,
    );
  }
  if (head && sameZone(head.tz, candidate.tz)) {
    return { entries, line: null, noop: true };
  }
  const entry: TzJournalEntry = { from: candidate.from, instant, tz: candidate.tz, note: candidate.note };
  return { entries: [...entries, entry], line: formatTzEntry(candidate), noop: false };
}
