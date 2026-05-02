// Golden-output tests for the stamp/gap injection logic in extensions/dmn-context.ts.
// No pi runtime, no LLM. Pure transform over in-memory message arrays.
//
// Bug class guarded:
//   1. Crash when iterating messages whose role doesn't carry a `.content` field
//      (e.g. BashExecutionMessage). The role narrow must hold.
//   2. Failure to narrow inside the array-content branch — only `text` blocks
//      should receive the prefix; non-text blocks must not be mutated.
//
// All fixtures use Date.UTC() and tz="UTC" so the snapshot is wall-clock-stable.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStamps, GAP_MS } from "../extensions/dmn-context.ts";

const TZ = "UTC";

// 2026-05-02 14:30:00 UTC
const T0 = Date.UTC(2026, 4, 2, 14, 30, 0);
const STAMP_T0 = "Sat, May 2, 2:30 PM UTC";

test("steady cadence — first and last stamped, no silence markers", () => {
  const msgs: any[] = [
    { role: "user", content: "one",   timestamp: T0 },
    { role: "user", content: "two",   timestamp: T0 + 30_000 },
    { role: "user", content: "three", timestamp: T0 + 60_000 },
  ];
  applyStamps(msgs, TZ);

  assert.equal(msgs[0].content, `[${STAMP_T0}] one`);
  // middle message: not first, not last, no gap → untouched
  assert.equal(msgs[1].content, "two");
  assert.equal(msgs[2].content, `[Sat, May 2, 2:31 PM UTC] three`);

  for (const m of msgs) {
    assert.ok(!String(m.content).includes("of silence"), "no silence markers expected");
  }
});

test("long gap — silence marker prefixed on the post-gap message", () => {
  const gap = 20 * 60 * 1000; // 20 minutes, well above GAP_MS (4:30)
  assert.ok(gap >= GAP_MS);

  const msgs: any[] = [
    { role: "user", content: "before", timestamp: T0 },
    { role: "user", content: "after",  timestamp: T0 + gap },
  ];
  applyStamps(msgs, TZ);

  assert.equal(msgs[0].content, `[${STAMP_T0}] before`);
  assert.equal(
    msgs[1].content,
    `[20 minutes of silence]\n[Sat, May 2, 2:50 PM UTC] after`,
  );
});

test("mixed shapes — bashExecution does not crash and does not get stamped", () => {
  const msgs: any[] = [
    { role: "user", content: "hi", timestamp: T0 },
    {
      // No .content field. If the role narrow is removed this entry would
      // either crash on Array.isArray(undefined) (fine) or, worse, end up with
      // a `content` property the loop assigned. Either way: must not mutate.
      role: "bashExecution",
      command: "ls",
      output: "a\nb\n",
      exitCode: 0,
      cancelled: false,
      truncated: false,
      timestamp: T0 + 1_000,
    },
    {
      role: "assistant",
      content: [
        { type: "text", text: "hello back" },
      ],
      timestamp: T0 + 2_000,
    },
    { role: "user", content: "bye", timestamp: T0 + 3_000 },
  ];

  // Must not throw.
  applyStamps(msgs, TZ);

  // bashExecution untouched
  assert.equal(msgs[1].role, "bashExecution");
  assert.equal((msgs[1] as any).content, undefined);
  assert.equal(msgs[1].command, "ls");

  // first user stamped, last user stamped
  assert.equal(msgs[0].content, `[${STAMP_T0}] hi`);
  assert.equal(msgs[3].content, `[${STAMP_T0}] bye`);

  // assistant in the middle was not in stampSet (only user indices feed it)
  assert.deepEqual(msgs[2].content, [{ type: "text", text: "hello back" }]);
});

test("array content — prefix prepended to FIRST text block only; non-text untouched", () => {
  // Arrange a scenario where an *assistant* message lands in stampSet. The
  // current implementation only puts user indices into stampSet, so to exercise
  // the array branch we use a `user` message whose content is an array of
  // blocks (legal per the message types: TextContent | ImageContent).
  const msgs: any[] = [
    {
      role: "user",
      content: [
        { type: "image", source: { type: "base64", media_type: "image/png", data: "AAA" } },
        { type: "text", text: "first text" },
        { type: "text", text: "second text" },
      ],
      timestamp: T0,
    },
    // Force a gap so msg[0] is both first AND on the pre-gap edge — keeps it
    // a single stamp, no silence marker on it.
    { role: "user", content: "tail", timestamp: T0 + 30 * 60 * 1000 },
  ];
  applyStamps(msgs, TZ);

  const blocks = msgs[0].content;
  // image block untouched
  assert.deepEqual(blocks[0], {
    type: "image",
    source: { type: "base64", media_type: "image/png", data: "AAA" },
  });
  // first text block got the prefix
  assert.equal(blocks[1].text, `[${STAMP_T0}] first text`);
  // second text block untouched
  assert.equal(blocks[2].text, "second text");

  // tail has the silence marker
  assert.equal(
    msgs[1].content,
    `[30 minutes of silence]\n[Sat, May 2, 3:00 PM UTC] tail`,
  );
});
