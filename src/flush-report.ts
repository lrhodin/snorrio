// The flush protocol between the daemon and `snorrio flush`.
//
// The CLI learns what a flush did by tailing the daemon's log, so the log lines
// below are an interface, not prose. Each failure is one JSON line, because the
// CLI must say *what* failed and *what to do*, and both depend on fields a
// free-text line would make it guess at (which session, which date, which level).
//
// Why flush reports failures at all: it used to print
//   "✓ 7 episodes (1 failed) — caches updating in background"
// and the week-and-up caches kept rebuilding after it returned. A refused
// session, a day cache the output check rejected, or a failed year rebuild was
// easy to miss and had no next step attached. Now flush waits for the whole
// cascade and exits non-zero naming each failure with its remedy.
//
// Dependency-free so bin/snorrio can import it without the daemon's module graph.

export const FLUSH_TRIGGERED = "Flush triggered";
export const FLUSH_FAILURE = "Flush failure: ";
export const FLUSH_COMPLETE = "Flush complete: ";

export type FlushFailureKind = "episode" | "day" | "week" | "month" | "quarter" | "year" | "flush";

export interface FlushFailure {
  kind: FlushFailureKind;
  /** Session id (episode) or cache ref (2026-10-02, 2026-W40, ...). */
  ref: string;
  /** Local date the episode belongs to, when known. */
  date?: string;
  /** Session file, for episodes. */
  session?: string;
  error: string;
}

export function formatFlushFailure(f: FlushFailure): string {
  return FLUSH_FAILURE + JSON.stringify(f);
}

export function formatFlushComplete(processed: number, failures: number): string {
  return `${FLUSH_COMPLETE}${processed} processed, ${failures} failure${failures === 1 ? "" : "s"}`;
}

/** Parse one log line; null if it is not a flush failure line. */
export function parseFlushFailure(line: string): FlushFailure | null {
  const at = line.indexOf(FLUSH_FAILURE);
  if (at < 0) return null;
  try {
    const f = JSON.parse(line.slice(at + FLUSH_FAILURE.length));
    return f && typeof f.kind === "string" && typeof f.error === "string" ? f : null;
  } catch {
    return null;
  }
}

export type FailureCause = "tos" | "transient" | "rejected" | "other";

export function classifyFailure(error: string): FailureCause {
  if (/Terms of Service/i.test(error)) return "tos";
  if (/rebuild rejected/i.test(error)) return "rejected";
  if (/overload|rate.?limit|\b429\b|\b5\d\d\b|timed? ?out|ETIMEDOUT|ECONNRESET|ECONNREFUSED|socket hang up|fetch failed|network/i.test(error)) {
    return "transient";
  }
  return "other";
}

/** What failed and what to do about it, for a human at a terminal. */
export function describeFailure(f: FlushFailure, logPath: string): string {
  const what = f.kind === "episode"
    ? `episode for session ${f.ref}${f.date ? ` (${f.date})` : ""}${f.session ? `\n    ${f.session}` : ""}`
    : f.kind === "flush" ? "flush" : `${f.kind} cache ${f.ref}`;
  // A failed episode leaves its session stale on disk, so the next flush picks
  // it up again; a cache only comes back through reprocess.
  const rerun = f.kind === "episode" || f.kind === "flush"
    ? "snorrio flush"
    : `snorrio reprocess ${f.ref} ${f.kind}`;

  let todo: string;
  switch (classifyFailure(f.error)) {
    case "tos":
      todo = `The provider refused it under its Terms of Service (reverse-engineering filter). `
        + `Retrying on the same model often hits the same refusal; run it on a different model (a non-Anthropic one avoids the filter entirely): `
        + `set tools.dmn.model in ~/snorrio/config/config.json, run \`${rerun}\`, then restore the setting.`;
      break;
    case "transient":
      todo = `Transient API error (overload / rate limit / network). Re-run \`${rerun}\`.`;
      break;
    case "rejected":
      todo = `The output check rejected the rebuilt summary. \`${rerun}\` regenerates it.`;
      break;
    default:
      todo = `See ${logPath}.`;
  }
  return `  ✗ ${what}\n    ${f.error}\n    → ${todo}`;
}
