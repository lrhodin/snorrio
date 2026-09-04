import { test, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let tmp: string;
let recall: (ref: string, question: string, model?: string | null, options?: any) => Promise<string>;
let setCompleteForTest: (fn: ((...args: any[]) => any) | null) => void;
const saved = { HOME: process.env.HOME, SNORRIO_HOME: process.env.SNORRIO_HOME };
const day = "2026-09-03";

before(async () => {
  tmp = mkdtempSync(join(tmpdir(), "snorrio-recall-cancel-"));
  process.env.HOME = tmp;
  process.env.SNORRIO_HOME = join(tmp, "snorrio");
  const episodeDir = join(process.env.SNORRIO_HOME, "episodes", day);
  mkdirSync(episodeDir, { recursive: true });
  writeFileSync(
    join(episodeDir, "session.md"),
    `<!-- session: session | ${day} 10:00→10:01 | model:test -->\n\nwork`,
  );
  const mod = await import("../src/recall-engine.ts");
  recall = mod.recall;
  setCompleteForTest = mod.__setCompleteForTest;
});

after(() => {
  setCompleteForTest?.(null);
  if (tmp) rmSync(tmp, { recursive: true, force: true });
  if (saved.HOME === undefined) delete process.env.HOME;
  else process.env.HOME = saved.HOME;
  if (saved.SNORRIO_HOME === undefined) delete process.env.SNORRIO_HOME;
  else process.env.SNORRIO_HOME = saved.SNORRIO_HOME;
});

test("recall forwards its AbortSignal to the non-streaming model boundary", async () => {
  const controller = new AbortController();
  let received: AbortSignal | undefined;
  setCompleteForTest(async (_messages, _system, _model, _tool, options) => {
    received = options?.signal;
    return { stopReason: "end", content: [{ type: "text", text: "ok" }] };
  });

  assert.equal(await recall(day, "question", null, { signal: controller.signal }), "ok");
  assert.equal(received, controller.signal);
});

test("an aborted non-streaming model call returns the abort marker", async () => {
  const controller = new AbortController();
  setCompleteForTest(async (_messages, _system, _model, _tool, options) => {
    return new Promise((_resolve, reject) => {
      options.signal.addEventListener(
        "abort",
        () => reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
        { once: true },
      );
    });
  });

  const pending = recall(day, "question", null, { signal: controller.signal });
  controller.abort();
  assert.equal(await pending, "[recall: aborted]");
});

test("parallel recalls keep cancellation context isolated", async () => {
  const first = new AbortController();
  const second = new AbortController();
  const received: AbortSignal[] = [];
  setCompleteForTest(async (_messages, _system, _model, _tool, options) => {
    received.push(options.signal);
    await new Promise((resolve) => setImmediate(resolve));
    return { stopReason: "end", content: [{ type: "text", text: "ok" }] };
  });

  await Promise.all([
    recall(day, "first", null, { signal: first.signal }),
    recall(day, "second", null, { signal: second.signal }),
  ]);

  assert.equal(received.length, 2);
  assert.ok(received.includes(first.signal));
  assert.ok(received.includes(second.signal));
});
