// Golden-output tests for the stamp/gap injection logic in extensions/dmn-context.ts.
// No pi runtime, no LLM. Pure transform over in-memory message arrays.
//
// Bug class guarded:
//   1. Crash when iterating messages whose role doesn't carry a `.content` field
//      (e.g. BashExecutionMessage). The role narrow must hold.
//   2. Failure to narrow inside the array-content branch — only `text` blocks
//      should receive the prefix; non-text blocks must not be mutated.
//
// All fixtures use Date.UTC() and a constant "UTC" resolver so the snapshot is
// wall-clock-stable. The resolver is a function, not a zone string, because a
// stamp names when a message was written: see the era-boundary test at the end.

import { test } from "node:test";
import assert from "node:assert/strict";
import { applyStamps, composeInjectedPrompt, GAP_MS } from "../extensions/dmn-context.ts";

const TZ = "UTC";

// 2026-05-02 14:30:00 UTC
const T0 = Date.UTC(2026, 4, 2, 14, 30, 0);
const STAMP_T0 = "Sat, May 2, 2:30 PM UTC";

test("prompt composition uses freshly supplied date/context on every turn", () => {
  const base = "Current date: 2026-08-23\nbase";
  const first = composeInjectedPrompt(base, "2026-08-23", "setup-once", "cache-v1");
  const second = composeInjectedPrompt(base, "2026-08-24", "setup-once", "cache-v2");
  assert.match(first, /Current date: 2026-08-23/);
  assert.match(first, /cache-v1/);
  assert.match(second, /Current date: 2026-08-24/);
  assert.match(second, /cache-v2/);
  assert.doesNotMatch(second, /cache-v1/);
});

test("steady cadence — first and last stamped, no silence markers", () => {
  const msgs: any[] = [
    { role: "user", content: "one",   timestamp: T0 },
    { role: "user", content: "two",   timestamp: T0 + 30_000 },
    { role: "user", content: "three", timestamp: T0 + 60_000 },
  ];
  applyStamps(msgs, () => TZ);

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
  applyStamps(msgs, () => TZ);

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
  applyStamps(msgs, () => TZ);

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
  applyStamps(msgs, () => TZ);

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

test("each stamp renders in the zone the message was written in, not the reader's", () => {
  // The bug this replaces: the extension resolved ONE zone in its default export
  // and stamped every message with it, so reopening a Stockholm session from
  // California reprinted the whole transcript in Pacific. A stamp is a claim
  // about when a message was written; that claim does not change when the reader
  // moves. Here the journal head is Pacific and the older messages are Stockholm
  // era — they must still say CEST.
  const stockholmEra = Date.UTC(2026, 8, 2, 20, 0, 0); // 2026-09-02 22:00 CEST
  const pacificEra = Date.UTC(2026, 8, 10, 20, 0, 0);  // 2026-09-10 13:00 PDT
  const boundary = Date.UTC(2026, 8, 5, 0, 0, 0);
  const zoneFor = (ts: number) => (ts < boundary ? "Europe/Stockholm" : "America/Los_Angeles");

  const msgs: any[] = [
    { role: "user", content: "packing", timestamp: stockholmEra },
    { role: "user", content: "landed",  timestamp: pacificEra },
  ];
  applyStamps(msgs, zoneFor);

  assert.equal(msgs[0].content, "[Wed, Sep 2, 10:00 PM GMT+2] packing");
  assert.match(msgs[1].content, /^\[8 days of silence\]\n\[Thu, Sep 10, 1:00 PM PDT\] landed$/);
});
