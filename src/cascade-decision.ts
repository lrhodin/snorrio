// Pure cascade decision logic for the episode daemon.
//
// Given a set of episode dates and a starting level, decide which refs
// at each tier (day/week/month/quarter/year) need to be regenerated.
// No filesystem access. No timestamp tracking. The contract is intentionally
// simple: when called, every tier from `from` upward is rebuilt for the
// derived refs of the input dates. The only suppression is `skipCascade`.

export interface CascadeDecision {
  day: string[];
  week: string[];
  month: string[];
  quarter: string[];
  year: string[];
}

export type CascadeLevel = keyof CascadeDecision;

export const CASCADE_ORDER: CascadeLevel[] = ["day", "week", "month", "quarter", "year"];

export function dateToWeek(dateStr: string): string {
  // ISO 8601 week date. Algorithm:
  //   1. Find the Thursday of the week containing this date — ISO weeks
  //      are anchored to Thursday, so the Thursday's calendar year is
  //      the ISO week-numbering year.
  //   2. Week 1 is the week containing Jan 4 (equivalently: the week
  //      whose Thursday is in January).
  //   3. Week number = 1 + (target Thursday − W01 Thursday) / 7 days.
  // All arithmetic in UTC to dodge DST. Prior implementation drifted at
  // year boundaries (2024-12-30 → 2025-W53; 2021-01-03 → 2020-W01).
  const dt = new Date(dateStr + "T00:00:00Z");
  const target = new Date(Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()));
  const dayNum = (target.getUTCDay() + 6) % 7; // 0=Mon..6=Sun
  target.setUTCDate(target.getUTCDate() - dayNum + 3); // Thursday of this week
  const isoYear = target.getUTCFullYear();
  const jan4 = new Date(Date.UTC(isoYear, 0, 4));
  const jan4DayNum = (jan4.getUTCDay() + 6) % 7;
  const week1Thursday = new Date(jan4.getTime());
  week1Thursday.setUTCDate(jan4.getUTCDate() - jan4DayNum + 3);
  const weekNum = 1 + Math.round((target.getTime() - week1Thursday.getTime()) / (7 * 86400000));
  return `${isoYear}-W${String(weekNum).padStart(2, "0")}`;
}

export function monthToQuarter(monthStr: string): string {
  const [year, month] = monthStr.split("-").map(Number);
  return `${year}-Q${Math.ceil(month / 3)}`;
}

function emptyDecision(): CascadeDecision {
  return { day: [], week: [], month: [], quarter: [], year: [] };
}

/**
 * Pure decision: given input dates and a starting tier, return the refs to
 * regenerate at each tier. `skipCascade` short-circuits to all-empty.
 *
 * NOTE: This implementation matches the daemon's actual behavior, which does
 * NOT track per-tier last-regeneration timestamps. Every call cascades
 * unconditionally from `from` up to year. The README's "first episode of new
 * day → regenerate month/quarter/year" wording describes intent, not
 * implementation; in practice every live-mode episode regenerates the full
 * stack for the date it lands on. See output report for the divergence.
 */
export function decideCascade(
  dates: Iterable<string>,
  from: CascadeLevel = "day",
  opts?: { skipCascade?: boolean },
): CascadeDecision {
  if (opts?.skipCascade) return emptyDecision();
  const all = [...new Set([...dates])].sort();
  if (all.length === 0) return emptyDecision();

  const fromIdx = CASCADE_ORDER.indexOf(from);
  if (fromIdx < 0) return emptyDecision();

  const out = emptyDecision();
  for (let i = fromIdx; i < CASCADE_ORDER.length; i++) {
    const lvl = CASCADE_ORDER[i];
    let refs: string[];
    switch (lvl) {
      case "day":     refs = all.slice(); break;
      case "week":    refs = [...new Set(all.map(dateToWeek))]; break;
      case "month":   refs = [...new Set(all.map(d => d.slice(0, 7)))]; break;
      case "quarter": refs = [...new Set(all.map(d => monthToQuarter(d.slice(0, 7))))]; break;
      case "year":    refs = [...new Set(all.map(d => d.slice(0, 4)))]; break;
    }
    out[lvl] = refs.sort();
  }
  return out;
}
