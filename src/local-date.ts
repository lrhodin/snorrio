// Resolving an instant into a wall-clock date in a named zone.
//
// The wrong way, which this module replaces, was
//   new Date(d.toLocaleString("en-US", { timeZone: tz }))
// — format an instant into a human string, then hand that string back to the
// Date parser and read local-time getters off the result. It survives only
// because en-US "M/D/YYYY, h:mm:ss AM/PM" happens to be a shape V8's parser
// accepts and the host zone happens to cancel out. Nothing guarantees either:
// the parse is implementation-defined, minute-offset zones (Asia/Kathmandu
// +05:45, Australia/Eucla +08:45, Pacific/Marquesas -09:30) round-trip only by
// luck, and any derived value read with a local-time getter silently reintroduces
// the host zone the conversion was supposed to remove.
//
// Intl.DateTimeFormat with en-CA already yields YYYY-MM-DD directly, and it is
// what src/episode-daemon.ts toDateStr() has always used to choose an episode's
// directory. So this module is the same tool the bucketing key is built with —
// every other zone-dependent derivation now hangs off the resolved Y/M/D rather
// than off a reparsed Date.

import { dateToWeek } from "./cascade-decision.ts";

export interface LocalDateParts {
  /** YYYY-MM-DD in `tz`. The bucketing key. */
  date: string;
  year: number;
  /** 1-12. */
  month: number;
  /** 1-31. */
  day: number;
}

/** Wall-clock calendar date of `instant` in `tz`. */
export function resolveLocalDate(instant: Date, tz: string): LocalDateParts {
  // en-CA renders as YYYY-MM-DD, so no reparse and no locale-order guessing.
  const formatted = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit",
  }).format(instant);
  const [year, month, day] = formatted.split("-").map(Number);
  return { date: formatted, year, month, day };
}

/**
 * Offset of `tz` at `instant` as "+HH:MM" / "-HH:MM".
 *
 * Recorded for human readability only — never used for arithmetic, because an
 * offset is a fact about one instant and a zone's offset changes underneath it.
 */
export function resolveUtcOffset(instant: Date, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-US", { timeZone: tz, timeZoneName: "longOffset" })
    .formatToParts(instant);
  const raw = parts.find((part) => part.type === "timeZoneName")?.value ?? "GMT";
  // "GMT+02:00" | "GMT-07:00" | bare "GMT" for a zero offset.
  const match = raw.match(/GMT([+-])(\d{1,2})(?::(\d{2}))?/);
  if (!match) return "+00:00";
  const [, sign, hours, minutes] = match;
  return `${sign}${hours.padStart(2, "0")}:${minutes ?? "00"}`;
}

export interface TemporalRefs {
  today: string;
  yesterday: string;
  week: string;
  month: string;
  quarter: string;
  year: string;
}

/**
 * The five cache refs for the day `instant` falls on in `tz`.
 *
 * Everything above the day is derived from the resolved Y/M/D by pure UTC
 * arithmetic — `yesterday` by subtracting a day from the UTC-projected
 * calendar date (never `setDate()` on a fake-local Date), and `week` by the
 * shared ISO implementation in cascade-decision.ts rather than a second
 * hand-rolled week formula that disagrees with it at year boundaries.
 */
export function temporalRefs(instant: Date, tz: string): TemporalRefs {
  const { date, year, month, day } = resolveLocalDate(instant, tz);
  const previous = new Date(Date.UTC(year, month - 1, day) - 86_400_000)
    .toISOString().slice(0, 10);
  return {
    today: date,
    yesterday: previous,
    week: dateToWeek(date),
    month: date.slice(0, 7),
    quarter: `${year}-Q${Math.ceil(month / 3)}`,
    year: String(year),
  };
}
