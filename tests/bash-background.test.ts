// Real processes through pi's local bash operations; no pi runtime, no LLM.
import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createBashToolDefinition, createLocalBashOperations, type BashOperations } from "@earendil-works/pi-coding-agent";
import { JobManager, lastLines, type Job } from "../extensions/bash-background.ts";

function setup() {
  const ended: Job[] = [];
  const mgr = new JobManager(mkdtempSync(join(tmpdir(), "bg-")), createLocalBashOperations(), j => ended.push(j));
  return { mgr, ended };
}

function tool(mgr: JobManager, onJob: (j: Job) => void = () => {}) {
  const operations: BashOperations = { exec: (c, cwd, o) => mgr.exec(c, cwd, o, onJob) };
  return createBashToolDefinition(process.cwd(), { operations, exposeSessionEnvironment: false });
}

const until = async (cond: () => boolean) => { while (!cond()) await new Promise(r => setTimeout(r, 20)); };

test("attached call behaves like plain bash", async () => {
  const { mgr, ended } = setup();
  const r = await tool(mgr).execute("t", { command: "echo hi; exit 0" }, undefined, undefined, {} as never);
  assert.match((r.content[0] as { text: string }).text, /hi/);
  assert.equal(ended.length, 0, "attached jobs never report");
});

test("detached job keeps running, logs everything, reports once", async () => {
  const { mgr, ended } = setup();
  let job!: Job;
  const run = tool(mgr, j => { job = j; }).execute("t", { command: "echo start; sleep 0.4; echo end; exit 3" }, undefined, undefined, {} as never);
  run.catch(() => {});
  await until(() => !!job && job.tail.includes("start"));
  assert.equal(mgr.detach(), job);
  await job.ended;
  assert.equal(job.status, "done");
  assert.equal(job.exitCode, 3);
  assert.deepEqual(ended, [job]);
  await until(() => readFileSync(job.logPath, "utf8").includes("end"));
});

test("caller abort after detach does not kill the job", async () => {
  const { mgr } = setup();
  const ac = new AbortController();
  let job!: Job;
  tool(mgr, j => { job = j; }).execute("t", { command: "sleep 0.3; echo ok" }, ac.signal, undefined, {} as never).catch(() => {});
  await until(() => !!job);
  mgr.detach();
  ac.abort();
  await job.ended;
  assert.equal(job.status, "done");
  assert.match(job.tail, /ok/);
});

test("caller abort while attached kills the job", async () => {
  const { mgr, ended } = setup();
  const ac = new AbortController();
  let job!: Job;
  const run = tool(mgr, j => { job = j; }).execute("t", { command: "sleep 5" }, ac.signal, undefined, {} as never);
  await until(() => !!job);
  ac.abort();
  await assert.rejects(run, /aborted/);
  assert.equal(job.status, "killed");
  assert.equal(ended.length, 0);
});

test("timeout applies only while attached", async () => {
  const { mgr } = setup();
  const run = tool(mgr).execute("t", { command: "sleep 5", timeout: 0.2 }, undefined, undefined, {} as never);
  await assert.rejects(run, /timed out/);

  let job!: Job;
  tool(mgr, j => { job = j; }).execute("t", { command: "sleep 0.5; echo survived", timeout: 0.2 }, undefined, undefined, {} as never).catch(() => {});
  await until(() => !!job);
  mgr.detach();
  await job.ended;
  assert.equal(job.status, "done");
});

test("kill reports a detached job; killAll stays silent", async () => {
  const { mgr, ended } = setup();
  const jobs: Job[] = [];
  for (let i = 0; i < 2; i++) {
    tool(mgr, j => { jobs.push(j); }).execute("t", { command: "sleep 5" }, undefined, undefined, {} as never).catch(() => {});
    await until(() => jobs.length === i + 1);
    mgr.detach();
  }
  mgr.kill(jobs[0].id);
  await jobs[0].ended;
  assert.equal(jobs[0].status, "killed");
  assert.deepEqual(ended, [jobs[0]]);
  mgr.killAll();
  await jobs[1].ended;
  assert.equal(ended.length, 1);
});

test("detach with nothing running returns undefined", () => {
  assert.equal(setup().mgr.detach(), undefined);
});

test("lastLines bounds lines and bytes", () => {
  const text = Array.from({ length: 200 }, (_, i) => `line ${i}`).join("\n");
  const out = lastLines(text, 50);
  assert.equal(out.split("\n").length, 50);
  assert.match(out, /line 199$/);
  assert.ok(lastLines("x".repeat(20000), 50, 100).length <= 100);
});
