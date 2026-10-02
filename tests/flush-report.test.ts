// Tests for `snorrio flush` failing loud.
//
// The incident: flush printed "✓ 7 episodes (1 failed) — caches updating in
// background" while a session had been refused under the provider's Terms of
// Service, and on the next run a day cache the output check rejected was only a
// log line. Flush now waits for the whole cascade, names every failure with its
// remedy, and exits non-zero unless --allow-failures. The error strings below
// are verbatim from ~/snorrio/logs/2026-10-02.log.

import { test } from "node:test";
import assert from "node:assert/strict";
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, unlinkSync } from "node:fs";
import { spawn } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import {
  classifyFailure, describeFailure, formatFlushComplete, formatFlushFailure, parseFlushFailure,
  FLUSH_TRIGGERED, type FlushFailure,
} from "../src/flush-report.ts";

const PKG_ROOT = join(fileURLToPath(import.meta.url), "..", "..");
const TOS = "API error: This request was blocked as it seems to violate Anthropic's Terms of Service restrictions on reverse engineering or duplicating model outputs. To learn more, visit https://www.anthropic.com/legal/comm";
const OVERLOAD = 'API error: {"type":"error","error":{"details":null,"type":"overloaded_error","message":"Overloaded"},"request_id":"req_011Cfd9ugpXYkBDPc9NXFcdo"}';
const REJECTED = "cache rebuild rejected day 2026-10-02: exposes provenance machinery";
const LOG = "/home/u/snorrio/logs/2026-10-02.log";

const episode = (error: string): FlushFailure => ({
  kind: "episode", ref: "1b7555a8", date: "2026-10-02",
  session: "/home/u/.pi/agent/sessions/x/2026-10-02T20-00-00-000Z_1b7555a8.jsonl", error,
});

test("failure lines round-trip through the log", () => {
  const f = episode(TOS);
  const line = `[DMN] 2026-10-02T22:13:58.078Z ${formatFlushFailure(f)}`;
  assert.ok(!line.slice(0, -1).includes("\n"), "one log line");
  assert.deepEqual(parseFlushFailure(line), f);
  assert.equal(parseFlushFailure("[DMN] x   API error 1b7555a8: boom"), null);
  assert.equal(parseFlushFailure("[DMN] x Flush failure: {not json"), null);
});

test("errors are classified by cause", () => {
  assert.equal(classifyFailure(TOS), "tos");
  assert.equal(classifyFailure(OVERLOAD), "transient");
  assert.equal(classifyFailure("cache rebuild returned no usable summary for week 2026-W40: [recall: API error — 529 Overloaded]"), "transient");
  assert.equal(classifyFailure(REJECTED), "rejected");
  assert.equal(classifyFailure("day cache rebuild rejected: exposes provenance machinery"), "rejected");
  assert.equal(classifyFailure("empty context"), "other");
});

test("a ToS refusal names the session and points at a different model", () => {
  const out = describeFailure(episode(TOS), LOG);
  assert.match(out, /1b7555a8/);
  assert.match(out, /_1b7555a8\.jsonl/);
  assert.match(out, /different model/);
  assert.match(out, /tools\.dmn\.model/);
});

test("a transient error says re-run", () => {
  assert.match(describeFailure(episode(OVERLOAD), LOG), /Re-run `snorrio flush`/);
});

test("a rejected day cache points at reprocessing that day", () => {
  const out = describeFailure({ kind: "day", ref: "2026-10-02", error: REJECTED }, LOG);
  assert.match(out, /day cache 2026-10-02/);
  assert.match(out, /`snorrio reprocess 2026-10-02 day` regenerates it/);
});

test("a higher cache failure names its level and ref", () => {
  const out = describeFailure({ kind: "year", ref: "2026", error: "cache rebuild returned no usable summary for year 2026" }, LOG);
  assert.match(out, /year cache 2026/);
  assert.match(out, new RegExp(`See ${LOG}`));
});

test("anything else prints the error and the log path", () => {
  const out = describeFailure(episode("context failed: bad json"), LOG);
  assert.match(out, /context failed: bad json/);
  assert.match(out, new RegExp(LOG));
});

// End to end against bin/snorrio: a fake daemon answers the trigger file.
async function runFlush(daemonLines: string[], args: string[] = []) {
  const home = mkdtempSync(join(tmpdir(), "snorrio-flush-"));
  const logs = join(home, "logs");
  mkdirSync(logs, { recursive: true });
  // TZ=UTC with no journal or config: the CLI's fallback zone is the host's.
  const logFile = join(logs, `${new Date().toISOString().slice(0, 10)}.log`);
  // A previous run's completion, already in the file, must not end this one.
  appendFileSync(logFile, `[DMN] t ${formatFlushComplete(3, 0)}\n`);
  const child = spawn(process.execPath, [join(PKG_ROOT, "bin/snorrio"), "flush", ...args], {
    env: { ...process.env, SNORRIO_HOME: home, TZ: "UTC" },
  });
  let stdout = "", stderr = "";
  child.stdout.on("data", d => { stdout += d; });
  child.stderr.on("data", d => { stderr += d; });
  const trigger = join(home, "flush");
  const fake = (async () => {
    while (!existsSync(trigger)) await new Promise(r => setTimeout(r, 20));
    unlinkSync(trigger);
    // Written in pieces, mid-line, the way a tail can catch it.
    const text = [`[DMN] t ${FLUSH_TRIGGERED}`, ...daemonLines.map(l => `[DMN] t ${l}`)].join("\n") + "\n";
    const cut = Math.floor(text.length / 2);
    appendFileSync(logFile, text.slice(0, cut));
    await new Promise(r => setTimeout(r, 300));
    appendFileSync(logFile, text.slice(cut));
  })();
  const code: number = await new Promise(r => child.on("close", r));
  await fake;
  rmSync(home, { recursive: true, force: true });
  return { code, stdout, stderr };
}

const FAILED_RUN = [
  "Flush: 2 pending",
  "  Done: 01a0fd7a → 10697 chars",
  formatFlushFailure(episode(TOS)),
  "Flush: 1 processed, 1 failed",
  "  Rebuilding 1 day cache",
  formatFlushFailure({ kind: "day", ref: "2026-10-02", error: REJECTED }),
  "  Rebuilding 1 week cache",
  formatFlushComplete(1, 2),
];

test("flush waits for completion and exits 1 with remedies", async () => {
  const r = await runFlush(FAILED_RUN);
  assert.equal(r.code, 1);
  assert.match(r.stdout, /✗ 1 episode — 2 failures:/);
  assert.doesNotMatch(r.stdout, /background/);
  assert.match(r.stderr, /session 1b7555a8/);
  assert.match(r.stderr, /snorrio reprocess 2026-10-02 day/);
});

test("--allow-failures reports but exits 0", async () => {
  const r = await runFlush(FAILED_RUN, ["--allow-failures"]);
  assert.equal(r.code, 0);
  assert.match(r.stderr, /1b7555a8/);
});

test("a clean flush exits 0", async () => {
  const r = await runFlush(["Flush: 1 pending", "  Done: 01a0fd7a → 10 chars", "Flush: 1 processed, 0 failed", formatFlushComplete(1, 0)]);
  assert.equal(r.code, 0);
  assert.match(r.stdout, /✓ 1 episode, caches up to date/);
  assert.equal(r.stderr, "");
});
