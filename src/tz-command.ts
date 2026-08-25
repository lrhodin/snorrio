// `snorrio tz` — read the timezone journal, and append to it.
//
// Deliberately not a daemon subcommand. migrate-provenance and
// migrate-local-dates go through src/episode-daemon.ts because they need its
// episode index, cascade and data-repo wiring; appending one line to a journal
// needs none of that, and routing it through the daemon module would load the
// whole watcher/LLM surface to write 60 bytes.
//
// Every function here is pure over injected IO so the write path is testable
// without a process: `tz set` is the mutating command, and the rule this repo
// learned on 2026-08-24 is that a mutating command must never infer consent.
// Flag validation lives in bin/snorrio via src/cli-args.ts (help wins, unknown
// flags stop the command); this module additionally refuses to write anything it
// cannot justify — a non-IANA zone, an out-of-order `from`, or a zone that is
// already in effect.

import { appendFileSync, mkdirSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import {
  SEEDED_ERA_NOTE,
  SEEDED_ERA_TZ,
  formatTzEntry,
  isValidZoneName,
  journalHead,
  readTzJournal,
  resolveZone,
  sameZone,
  tzJournalPath,
  type TzJournalEntry,
} from "./tz-journal.ts";

export interface TzCommandOptions {
  snorrioHome: string;
  now?: Date;
  /** The host zone, for the drift line in `tz show`. */
  systemZone?: string;
  /** Injected in tests to assert that nothing was written. */
  appendLine?: (path: string, line: string) => void;
}

export interface TzCommandResult {
  output: string;
  exitCode: number;
  /** Lines actually appended, in order. Empty for every read-only outcome. */
  written: string[];
}

function defaultAppend(path: string, line: string): void {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, line + "\n");
}

/**
 * When the pre-journal era began, or null if there is no pre-journal era.
 *
 * The earliest episode day directory, at 00:00Z: that is the earliest instant the
 * store has an opinion about, and every episode from it onward is stamped
 * `tz: Etc/UTC`, so the seeded era covers exactly the span the backfill claimed
 * and no more.
 *
 * null when there are no episodes — a fresh install has no history to attribute,
 * and seeding anyway would put the seed and the first real transition at the same
 * instant, which the monotonic check then (correctly) rejects. Also null if the
 * computed start is not strictly before `now`, which is the same collision
 * reached by a clock skew rather than an empty store.
 */
export function firstEraStart(episodesDir: string, now: Date): string | null {
  let earliest: string | null = null;
  try {
    for (const name of readdirSync(episodesDir)) {
      if (!/^\d{4}-\d{2}-\d{2}$/.test(name)) continue;
      if (earliest === null || name < earliest) earliest = name;
    }
  } catch {
    // No episodes directory yet — nothing to date the era from.
  }
  if (earliest === null) return null;
  const start = `${earliest}T00:00:00Z`;
  return Date.parse(start) < now.getTime() ? start : null;
}

function formatEntryLine(entry: TzJournalEntry): string {
  return `  ${entry.from}  ${entry.tz}${entry.note ? `  — ${entry.note}` : ""}`;
}

const RECENT_TRANSITIONS = 5;

export function tzShow(options: TzCommandOptions): TzCommandResult {
  const path = tzJournalPath(options.snorrioHome);
  const now = options.now ?? new Date();
  const systemZone = options.systemZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";

  let entries: TzJournalEntry[];
  try {
    entries = readTzJournal(path);
  } catch (err: any) {
    return {
      output: `tz journal is invalid: ${err?.message ?? err}\nFix ${path} by hand; nothing reads a journal it cannot trust.`,
      exitCode: 2,
      written: [],
    };
  }

  const lines: string[] = [];
  const head = journalHead(entries);
  if (!head) {
    lines.push(`Journal:   ${path} (absent — no transition recorded)`);
    lines.push(`System:    ${systemZone}`);
    lines.push(`Effective: ${systemZone} (source: system)`);
    lines.push("");
    lines.push(`Record the zone this machine is in with:  snorrio tz set ${systemZone}`);
    return { output: lines.join("\n"), exitCode: 0, written: [] };
  }

  const resolved = resolveZone(entries, now, systemZone);
  lines.push(`Journal:   ${path} (${entries.length} entr${entries.length === 1 ? "y" : "ies"})`);
  lines.push(`System:    ${systemZone}`);
  lines.push(`Effective: ${resolved.tz} (source: ${resolved.source}, since ${head.from})`);
  if (!sameZone(systemZone, head.tz)) {
    lines.push("");
    lines.push(`Drift: the system zone is ${systemZone} but the journal head says ${head.tz}.`);
    lines.push(`  If the machine moved, record it:  snorrio tz set ${systemZone}`);
    lines.push("  If it did not, fix the system zone instead — the journal is not auto-followed.");
  }
  lines.push("");
  const recent = entries.slice(-RECENT_TRANSITIONS);
  lines.push(`Transitions (most recent ${recent.length} of ${entries.length}):`);
  for (const entry of recent) lines.push(formatEntryLine(entry));
  return { output: lines.join("\n"), exitCode: 0, written: [] };
}

export function tzSet(zone: string, options: TzCommandOptions): TzCommandResult {
  const path = tzJournalPath(options.snorrioHome);
  const now = options.now ?? new Date();
  const append = options.appendLine ?? defaultAppend;
  const written: string[] = [];

  if (!isValidZoneName(zone)) {
    return {
      output: [
        `${JSON.stringify(zone)} is not an IANA zone name this runtime accepts.`,
        "Use a region/city name such as America/Los_Angeles or Europe/Stockholm.",
        "Fixed offsets are rejected on purpose: an offset is a fact about one",
        "instant, so it goes wrong at the next DST transition. An IANA name lets",
        "the tz database answer instead.",
      ].join("\n"),
      exitCode: 2,
      written,
    };
  }

  let entries: TzJournalEntry[];
  try {
    entries = readTzJournal(path);
  } catch (err: any) {
    return {
      output: [
        `tz journal is invalid: ${err?.message ?? err}`,
        `Refusing to append to a journal that cannot be read; fix ${path} by hand.`,
      ].join("\n"),
      exitCode: 2,
      written,
    };
  }

  const lines: string[] = [];

  // Seed the pre-journal era before the first real transition, so that episodes
  // already stamped `tz: Etc/UTC` sit inside an era that says so rather than
  // outside the journal entirely.
  const eraStart = entries.length === 0 ? firstEraStart(join(options.snorrioHome, "episodes"), now) : null;
  if (eraStart !== null) {
    const seed = { from: eraStart, tz: SEEDED_ERA_TZ, note: SEEDED_ERA_NOTE };
    const line = formatTzEntry(seed);
    append(path, line);
    written.push(line);
    entries = readTzJournalAfterAppend(path, entries, seed, options);
    lines.push(`Seeded the pre-journal era: ${seed.tz} from ${seed.from}`);
  }

  const head = journalHead(entries);
  if (head && sameZone(head.tz, zone)) {
    lines.push(`${zone} is already in effect (since ${head.from}) — nothing appended.`);
    return { output: lines.join("\n"), exitCode: 0, written };
  }

  const from = now.toISOString();
  if (head && Date.parse(from) <= head.instant) {
    lines.push(
      `Refusing to append ${from}: the journal head is already ${head.from} (${head.tz}).`,
      "The journal is append-only and monotonic — an entry that predates the head",
      "would reinterpret an era already used to bucket episodes.",
    );
    return { output: lines.join("\n"), exitCode: 2, written };
  }

  const line = formatTzEntry({ from, tz: zone });
  append(path, line);
  written.push(line);
  lines.push(`Recorded: ${zone} from ${from}`);
  lines.push("");
  lines.push("Episodes generated from now on resolve their day in this zone.");
  if (head) lines.push("Episodes already written keep the zone they were written in — history is not rewritten.");
  const systemZone = options.systemZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone ?? "UTC";
  if (!sameZone(systemZone, zone)) {
    lines.push("");
    lines.push(`Note: the system zone is still ${systemZone}. snorrio does not change it, and does not follow it.`);
  }
  return { output: lines.join("\n"), exitCode: 0, written };
}

// Re-read after the seed append so validation of the real entry runs against
// what is actually on disk. With an injected append (tests) the file will not
// have changed, so fall back to appending in memory.
function readTzJournalAfterAppend(
  path: string,
  before: TzJournalEntry[],
  seed: { from: string; tz: string; note?: string },
  options: TzCommandOptions,
): TzJournalEntry[] {
  if (!options.appendLine) {
    try {
      return readTzJournal(path);
    } catch {
      // Fall through to the in-memory view; the caller's next validation step
      // still refuses anything out of order.
    }
  }
  return [...before, { ...seed, instant: Date.parse(seed.from) }];
}
