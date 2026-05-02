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
  const dt = new Date(dateStr + "T12:00:00Z");
  const dayOfYear = Math.floor((Date.UTC(dt.getFullYear(), dt.getMonth(), dt.getDate()) - Date.UTC(dt.getFullYear(), 0, 1)) / 86400000) + 1;
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
