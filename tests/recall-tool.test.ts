import { test } from "node:test";
import assert from "node:assert/strict";
import { createRecallTool, type RecallEngine } from "../extensions/recall-tool.ts";

function engineWith(
  recall: RecallEngine["recall"],
): { engine: RecallEngine; load: () => Promise<RecallEngine> } {
  const engine = { recall };
  return { engine, load: async () => engine };
}

test("recall tool publishes accumulated text while the engine streams", async () => {
  const calls: any[] = [];
  const { load } = engineWith(async (target, question, model, options) => {
    calls.push({ target, question, model, options });
    options?.onChunk?.("First");
    options?.onChunk?.("First second");
    return "First second";
  });
  const tool = createRecallTool(load);
  const updates: any[] = [];

  const result = await tool.execute(
    "call-1",
    {
      target: "2026-W35",
      question: "What shipped?",
      context: true,
      at: "2026-09-01T00:00:00Z",
      model: "sonnet",
    },
    undefined,
    (update) => updates.push(update),
  );

  assert.equal(calls.length, 1);
  assert.deepEqual(
    {
      target: calls[0].target,
      question: calls[0].question,
      model: calls[0].model,
      context: calls[0].options.context,
      at: calls[0].options.at,
    },
    {
      target: "2026-W35",
      question: "What shipped?",
      model: "sonnet",
      context: true,
      at: "2026-09-01T00:00:00Z",
    },
  );
  assert.equal(updates.length, 3);
  assert.equal(updates[0].details.phase, "loading");
  assert.match(updates[1].content[0].text, /\n\nFirst$/);
  assert.match(updates[2].content[0].text, /\n\nFirst second$/);
  assert.equal(result.content[0].text, '[recall: 2026-W35 — "What shipped?"]\n\nFirst second');
  assert.equal(result.details.streamed, true);
});

test("recall tool still returns early markers when no model stream starts", async () => {
  const { load } = engineWith(async () => "[recall: no data found for 2020]");
  const tool = createRecallTool(load);
  const updates: any[] = [];

  const result = await tool.execute(
    "call-2",
    { target: "2020", question: "Anything?" },
    undefined,
    (update) => updates.push(update),
  );

  assert.equal(updates.length, 1);
  assert.equal(result.details.streamed, false);
  assert.match(result.content[0].text, /\[recall: no data found for 2020\]$/);
});

test("recall tool does not start work after cancellation", async () => {
  let loads = 0;
  const controller = new AbortController();
  controller.abort();
  const tool = createRecallTool(async () => {
    loads++;
    return { recall: async () => "unexpected" };
  });

  await assert.rejects(
    tool.execute(
      "call-3",
      { target: "2026", question: "Anything?" },
      controller.signal,
    ),
    /cancelled/i,
  );
  assert.equal(loads, 0);
});

test("recall tool passes cancellation into an in-flight engine call", async () => {
  const controller = new AbortController();
  let receivedSignal: AbortSignal | undefined;
  const updates: any[] = [];
  const { load } = engineWith(async (_target, _question, _model, options) => {
    receivedSignal = options?.signal;
    options?.onChunk?.("partial");
    return new Promise<string>((resolve) => {
      options?.signal?.addEventListener(
        "abort",
        () => resolve("[recall: aborted]"),
        { once: true },
      );
    });
  });
  const tool = createRecallTool(load);

  const execution = tool.execute(
    "call-4",
    { target: "2026", question: "Anything?" },
    controller.signal,
    (update) => updates.push(update),
  );
  await new Promise((resolve) => setImmediate(resolve));
  controller.abort();

  await assert.rejects(execution, /cancelled/i);
  assert.equal(receivedSignal, controller.signal);
  const countAtAbort = updates.length;
  await new Promise((resolve) => setTimeout(resolve, 75));
  assert.equal(updates.length, countAtAbort, "no partial update may fire after cancellation");
});
