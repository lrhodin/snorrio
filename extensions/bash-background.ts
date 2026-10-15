// Standalone: copy this file into ~/.pi/agent/extensions; no Snorrio imports.
//
// Background a running bash call. Press cmd+ctrl+b (super+ctrl+b) while a bash
// call runs: the call returns at once with the output so far, the command keeps
// running, and its result reaches the model as a message when it ends.
// /jobs and /kill <id> manage jobs; bg_status and bg_kill let the model do the same.
import type { BashOperations, ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { createBashToolDefinition, createLocalBashOperations, getAgentDir } from "@earendil-works/pi-coding-agent";
import { createWriteStream, mkdirSync, type WriteStream } from "node:fs";
import { join } from "node:path";
import { Type } from "typebox";

export const SHORTCUT = "ctrl+super+b";
const TAIL_BYTES = 64 * 1024;
const REPORT_LINES = 50;
const REPORT_BYTES = 8 * 1024;

type ExecOptions = Parameters<BashOperations["exec"]>[2];
export type JobStatus = "running" | "done" | "failed" | "killed";

export interface Job {
  id: number;
  command: string;
  startedAt: number;
  endedAt?: number;
  status: JobStatus;
  exitCode?: number;
  error?: string;
  logPath: string;
  attached: boolean;
  tail: string;
  ctrl: AbortController;
  log: WriteStream;
  onDetach?: () => void;
  ended: Promise<void>;
}

export function lastLines(text: string, lines = REPORT_LINES, bytes = REPORT_BYTES): string {
  let out = text.trimEnd().split("\n").slice(-lines).join("\n");
  if (out.length > bytes) out = out.slice(-bytes);
  return out.trimEnd();
}

export function duration(ms: number): string {
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

export function describe(job: Job, now = Date.now()): string {
  const state = job.status === "running" ? "running" : job.status === "done" ? `exit ${job.exitCode}` : job.status;
  return `#${job.id} ${state} ${duration((job.endedAt ?? now) - job.startedAt)}  ${job.command.split("\n")[0].slice(0, 80)}\n    log: ${job.logPath}`;
}

export function report(job: Job, now = Date.now()): string {
  const head = job.status === "running"
    ? `Background job #${job.id} is still running (${duration(now - job.startedAt)}).`
    : `Background job #${job.id} ${job.status === "done" ? `finished: exit ${job.exitCode}` : job.status} after ${duration((job.endedAt ?? now) - job.startedAt)}.`;
  const tail = lastLines(job.tail);
  return [
    head,
    `Command: ${job.command}`,
    `Full output: ${job.logPath}`,
    ...(job.error ? [`Error: ${job.error}`] : []),
    tail ? `--- last ${REPORT_LINES} lines ---\n${tail}` : "(no output yet)",
  ].join("\n");
}

/** Owns every bash process so a call can detach from its tool call without dying. */
export class JobManager {
  jobs = new Map<number, Job>();
  private next = 1;
  constructor(
    private dir: string,
    private inner: BashOperations,
    private onEnd: (job: Job) => void = () => {},
  ) {}

  /** BashOperations.exec for one tool call. `bind` receives the job before it starts. */
  exec(command: string, cwd: string, opts: ExecOptions, bind: (job: Job) => void): Promise<{ exitCode: number | null }> {
    mkdirSync(this.dir, { recursive: true });
    const id = this.next++;
    const startedAt = Date.now();
    const logPath = join(this.dir, `${new Date(startedAt).toISOString().replace(/[:.]/g, "-")}-${process.pid}-${id}.log`);
    let endedResolve!: () => void;
    const job: Job = {
      id, command, startedAt, logPath, status: "running", attached: true, tail: "",
      ctrl: new AbortController(), log: createWriteStream(logPath),
      ended: new Promise<void>(r => { endedResolve = r; }),
    };
    this.jobs.set(id, job);
    bind(job);

    let timedOut = false;
    const timer = opts.timeout && opts.timeout > 0
      ? setTimeout(() => { if (job.attached) { timedOut = true; job.ctrl.abort(); } }, opts.timeout * 1000)
      : undefined;
    const onCallerAbort = () => { if (job.attached) job.ctrl.abort(); };
    opts.signal?.addEventListener("abort", onCallerAbort, { once: true });
    if (opts.signal?.aborted) job.ctrl.abort();

    const onData = (data: Buffer) => {
      job.log.write(data);
      job.tail = (job.tail + data.toString("utf8")).slice(-TAIL_BYTES);
      if (job.attached) opts.onData(data);
    };

    const finish = (status: JobStatus, exitCode?: number, error?: string) => {
      if (timer) clearTimeout(timer);
      opts.signal?.removeEventListener("abort", onCallerAbort);
      if (job.status === "running") job.status = status;
      job.exitCode = exitCode;
      job.error = error;
      job.endedAt = Date.now();
      job.log.end();
      endedResolve();
      if (!job.attached) this.onEnd(job);
    };

    return this.inner.exec(command, cwd, { onData, signal: job.ctrl.signal, env: opts.env }).then(
      ({ exitCode }) => {
        const code = exitCode ?? 1;
        finish(job.ctrl.signal.aborted ? "killed" : "done", code);
        if (timedOut) throw new Error(`timeout:${opts.timeout}`);
        return { exitCode: code };
      },
      (err: unknown) => {
        const aborted = job.ctrl.signal.aborted;
        finish(aborted ? "killed" : "failed", undefined, aborted ? undefined : String((err as Error)?.message ?? err));
        if (timedOut) throw new Error(`timeout:${opts.timeout}`);
        throw err;
      },
    );
  }

  /** Detach the most recently started attached job. */
  detach(): Job | undefined {
    const job = [...this.jobs.values()].reverse().find(j => j.attached && j.status === "running");
    if (!job) return;
    job.attached = false;
    job.onDetach?.();
    return job;
  }

  kill(id: number): Job | undefined {
    const job = this.jobs.get(id);
    if (job?.status === "running") { job.status = "killed"; job.ctrl.abort(); }
    return job;
  }

  /** Kill everything without reporting: the session is going away. */
  killAll(): void {
    for (const job of this.jobs.values()) {
      if (job.status !== "running") continue;
      job.attached = true; // suppress the end report
      job.status = "killed";
      job.ctrl.abort();
    }
  }

  running(): Job[] { return [...this.jobs.values()].filter(j => j.status === "running"); }
  background(): Job[] { return [...this.jobs.values()].filter(j => !j.attached || j.status !== "running"); }
}

export default function (pi: ExtensionAPI) {
  let ctx: ExtensionContext | undefined;
  const setStatus = () => {
    const n = mgr.running().filter(j => !j.attached).length;
    ctx?.ui.setStatus("bash-background", n ? `bg: ${n} running` : undefined);
  };
  const mgr = new JobManager(join(getAgentDir(), "bg"), createLocalBashOperations(), job => {
    setStatus();
    pi.sendMessage(
      { customType: "bash-background", content: report(job), display: true, details: { id: job.id, status: job.status, exitCode: job.exitCode, logPath: job.logPath } },
      { triggerTurn: true, deliverAs: "steer" },
    );
  });

  const base = createBashToolDefinition(process.cwd());
  pi.registerTool({
    ...base,
    async execute(toolCallId, params, signal, onUpdate, toolCtx) {
      ctx = toolCtx;
      let job: Job | undefined;
      let detach!: () => void;
      const detached = new Promise<void>(r => { detach = r; });
      const operations: BashOperations = {
        exec: (command, cwd, opts) => mgr.exec(command, cwd, opts, j => { job = j; j.onDetach = detach; }),
      };
      let live = true;
      const run = createBashToolDefinition(toolCtx.cwd, { operations })
        .execute(toolCallId, params, signal, update => { if (live) onUpdate?.(update); }, toolCtx);
      const outcome = await Promise.race([run.then(r => ({ r })), detached.then(() => undefined)]);
      if (outcome) return outcome.r;
      live = false;
      run.catch(() => {});
      setStatus();
      const text = `${report(job!)}\nThe user moved this command to the background. Its result will arrive as a message when it ends; do not wait or poll for it. Use bg_status or bg_kill with job ${job!.id} only if needed.`;
      return { content: [{ type: "text", text }], details: undefined };
    },
  });

  pi.registerShortcut(SHORTCUT as Parameters<ExtensionAPI["registerShortcut"]>[0], {
    description: "Move the running bash call to the background",
    handler: c => {
      const job = mgr.detach();
      c.ui.notify(job ? `bash moved to background as job #${job.id}` : "No running bash call to background", job ? "info" : "warning");
    },
  });

  const jobParam = Type.Object({ job: Type.Number({ description: "Background job ID" }) });
  pi.registerTool({
    name: "bg_status",
    label: "bg_status",
    description: "Show a backgrounded bash job's status and latest output. Only for jobs the user moved to the background; finished jobs report themselves.",
    parameters: jobParam,
    async execute(_id, { job: id }) {
      const job = mgr.jobs.get(id);
      if (!job || (job.attached && job.status === "running")) throw new Error(`No background job #${id}`);
      return { content: [{ type: "text", text: report(job) }], details: undefined };
    },
  });
  pi.registerTool({
    name: "bg_kill",
    label: "bg_kill",
    description: "Stop a backgrounded bash job and its child processes.",
    parameters: jobParam,
    async execute(_id, { job: id }) {
      const job = mgr.jobs.get(id);
      if (!job || (job.attached && job.status === "running")) throw new Error(`No background job #${id}`);
      mgr.kill(id);
      await job.ended;
      return { content: [{ type: "text", text: report(job) }], details: undefined };
    },
  });

  pi.registerCommand("jobs", {
    description: "List background bash jobs",
    handler: async (_args, c) => {
      const jobs = mgr.background();
      c.ui.notify(jobs.length ? jobs.map(j => describe(j)).join("\n") : "No background jobs", "info");
    },
  });
  pi.registerCommand("kill", {
    description: "Stop a background bash job: /kill <id>",
    handler: async (args, c) => {
      const id = Number(args.trim().replace(/^#/, ""));
      const job = mgr.jobs.get(id);
      if (!job || (job.attached && job.status === "running")) { c.ui.notify("Usage: /kill <job id> (see /jobs)", "warning"); return; }
      if (job.status !== "running") { c.ui.notify(`Job #${id} already ${job.status}`, "info"); return; }
      mgr.kill(id);
      c.ui.notify(`Killing job #${id}`, "info");
    },
  });

  pi.on("session_start", (_e, c) => { ctx = c; setStatus(); });
  pi.on("session_shutdown", () => { mgr.killAll(); ctx = undefined; });
}
