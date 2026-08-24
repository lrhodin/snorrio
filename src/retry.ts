// Retry a flaky operation, reporting each attempt.
//
// Why this exists: cache rebuilds call an LLM, and under wide parallelism a
// provider occasionally returns nothing usable for one ref while the identical
// request succeeds moments later on its own. On 2026-08-24 a 26-day provenance
// migration ran 26 rebuilds concurrently, one returned no summary, strict mode
// threw, and the whole run aborted — discarding 25 successful rebuilds for a
// fault that was not reproducible. Retrying with backoff turns that class of
// failure into a delay instead of a lost run.
//
// The sleep is injectable so tests can assert the retry contract without
// actually waiting.

export interface AttemptOutcome {
  /** 1-based attempt number that produced this outcome. */
  attempt: number;
  /** Why the attempt failed; null means it succeeded. */
  problem: string | null;
  /** True when no further attempt will be made. */
  final: boolean;
}

export interface RetryOptions {
  /** Total attempts, including the first. Values below 1 are treated as 1. */
  attempts: number;
  /** Called after every attempt, for logging. */
  onAttempt?: (outcome: AttemptOutcome) => void;
  /** Delay before the next attempt, given the completed attempt number. */
  backoffMs?: (attempt: number) => number;
  /** Injectable sleep, so tests need not wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

/**
 * Run `operation` until it reports success or attempts are exhausted.
 *
 * `operation` returns null on success, or a message describing the failure.
 * Resolves to null on success, or the final failure message. Never throws for
 * an operation failure — callers decide what an exhausted retry means, which is
 * what lets a batch record partial progress instead of aborting.
 */
export async function withRetries(
  operation: (attempt: number) => Promise<string | null>,
  options: RetryOptions,
): Promise<string | null> {
  const attempts = Math.max(1, options.attempts);
  const backoffMs = options.backoffMs ?? ((attempt: number) => 2000 * attempt);
  const sleep = options.sleep ?? defaultSleep;

  let lastProblem: string | null = null;
  for (let attempt = 1; attempt <= attempts; attempt++) {
    let problem: string | null;
    try {
      problem = await operation(attempt);
    } catch (err: any) {
      // A thrown error is just another failure mode; retry it like any other.
      problem = err?.message?.slice(0, 100) ?? String(err);
    }
    const final = problem === null || attempt === attempts;
    options.onAttempt?.({ attempt, problem, final });
    if (problem === null) return null;
    lastProblem = problem;
    if (!final) await sleep(backoffMs(attempt));
  }
  return lastProblem;
}
