import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import {
  toReadableThinking,
  dropForeignThinking,
  THINKING_TYPES,
  normalizeSessionMessages,
  sessionMessagesToLlm,
  KNOWN_PI_ROLES,
} from "../src/model-independence.ts";

// Capture stderr writes around fn() so we can assert the warn-once behavior.
function captureStderr(fn: () => void): string[] {
  const writes: string[] = [];
  const orig = process.stderr.write.bind(process.stderr);
  (process.stderr as any).write = (s: any) => { writes.push(String(s)); return true; };
  try { fn(); } finally { (process.stderr as any).write = orig; }
  return writes;
}

const SESS = join(
  process.env.HOME!,
  ".pi/agent/sessions/--Users-ludvig-colter-projects-job-search--",
);

// Load a real session that contains thinking blocks from MORE THAN ONE model.
// (019e7b1f mixed gemini-3.5-flash + claude-opus-4-8.) Falls back to scanning.
function loadMixedSession(): any[] {
  const prefer = readdirSync(SESS).find((f) => f.includes("019e7b1f"));
  const files = prefer ? [prefer] : readdirSync(SESS).filter((f) => f.endsWith(".jsonl"));
  for (const f of files) {
    const msgs: any[] = [];
    for (const line of readFileSync(join(SESS, f), "utf8").split("\n")) {
      if (!line.trim()) continue;
      let o: any;
      try { o = JSON.parse(line); } catch { continue; }
      const m = o.message ?? o;
      if (m && (m.role === "assistant" || m.role === "user")) msgs.push(m);
    }
    const models = new Set(
      msgs
        .filter((m) => m.role === "assistant" && Array.isArray(m.content))
        .filter((m) => m.content.some((b: any) => THINKING_TYPES.has(b?.type)))
        .map((m) => m.model),
    );
    if (models.size >= 2) return msgs;
  }
  throw new Error("no mixed-model session with thinking blocks found");
}

const hasThinking = (m: any) =>
  Array.isArray(m.content) && m.content.some((b: any) => THINKING_TYPES.has(b?.type));
const hasSignature = (m: any) =>
  Array.isArray(m.content) && m.content.some((b: any) => b && "thinkingSignature" in b);

test("toReadableThinking: no thinking blocks or signatures survive; reasoning preserved as text", () => {
  const msgs = loadMixedSession();
  const before = msgs.filter(hasThinking).length;
  assert.ok(before > 0, "fixture should contain thinking blocks");

  const out = toReadableThinking(msgs);

  // No thinking/redacted blocks anywhere, no replay signatures anywhere.
  assert.equal(out.filter(hasThinking).length, 0, "all thinking blocks converted/dropped");
  assert.equal(out.filter(hasSignature).length, 0, "no thinkingSignature reaches the wire");

  // Reasoning content is preserved as <thinking>-wrapped text.
  const wrapped = out
    .filter((m) => Array.isArray(m.content))
    .flatMap((m) => m.content)
    .filter((b: any) => b?.type === "text" && typeof b.text === "string" && b.text.startsWith("<thinking>"));
  assert.ok(wrapped.length > 0, "reasoning rendered as readable <thinking> text");

  // Non-assistant + non-thinking content is untouched.
  assert.equal(out.length, msgs.length, "message count unchanged");
});

test("dropForeignThinking: keeps own-model thinking, drops the other model's", () => {
  const msgs = loadMixedSession();
  const models = [...new Set(
    msgs.filter((m) => m.role === "assistant" && hasThinking(m)).map((m) => m.model),
  )];
  assert.ok(models.length >= 2);

  // Reconstruct provider/api for each model from the fixture.
  const meta = (model: string) => {
    const m = msgs.find((x) => x.model === model && x.role === "assistant");
    return { id: model, provider: m.provider, api: m.api };
  };

  for (const target of models) {
    const out = dropForeignThinking(msgs, meta(target));
    for (const m of out) {
      if (m.role !== "assistant" || !hasThinking(m)) continue;
      // After the transform, only the target model may still carry thinking.
      assert.equal(m.model, target, `foreign thinking (${m.model}) should be dropped when target=${target}`);
    }
    // The target model's thinking (incl. its signature) must be retained.
    const keptForTarget = out.some((m) => m.model === target && hasThinking(m));
    assert.ok(keptForTarget, `target model ${target}'s own thinking is retained`);
  }
});

test("dropForeignThinking: no model => passthrough (never breaks)", () => {
  const msgs = loadMixedSession();
  assert.equal(dropForeignThinking(msgs, undefined), msgs);
});

test("normalizeSessionMessages: control messages narrowed; every output has content", () => {
  const raw = [
    { role: "user", content: "hi" },
    { role: "assistant", content: [{ type: "text", text: "hello" }] },
    { role: "branchSummary", summary: "explored a dead end", fromId: "x", timestamp: 1 },
    { role: "compactionSummary", summary: "earlier stuff", tokensBefore: 999, timestamp: 2 },
    { role: "bashExecution", command: "ls", output: "a\nb", exitCode: 0, timestamp: 3 },
    { role: "bashExecution", command: "secret", output: "x", excludeFromContext: true, timestamp: 4 },
    { role: "custom", customType: "note", content: "injected note", display: true, timestamp: 5 },
  ];

  const out = normalizeSessionMessages(raw as any);

  // The excluded bash escape is dropped; everything else survives (7 -> 6).
  assert.equal(out.length, 6, "excludeFromContext bash escape dropped");

  // No control roles remain on the wire.
  const controlRoles = new Set(["bashExecution", "branchSummary", "compactionSummary", "custom"]);
  assert.ok(out.every((m) => !controlRoles.has(m.role)), "no control roles survive");

  // The strict contract: every emitted message carries non-empty content.
  assert.ok(
    out.every((m) => (typeof m.content === "string" ? m.content.length > 0 : Array.isArray(m.content))),
    "every normalized message has content",
  );

  // Summaries are CONVERTED (their text is preserved), not dropped.
  const text = out.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  assert.match(text, /explored a dead end/, "branch summary text preserved");
  assert.match(text, /earlier stuff/, "compaction summary text preserved");
  assert.match(text, /\$ ls/, "bash escape rendered compactly");
  assert.match(text, /injected note/, "custom content preserved");
  assert.doesNotMatch(text, /secret/, "hidden bash escape not leaked");
});

test("allowlist-flip: an UNKNOWN role is caught (warned once + normalized/dropped, never emitted raw)", () => {
  // Use a role name no other test references so the module-level warn-once Set
  // isn't polluted by (or polluting) other cases.
  const ROLE = "futureControlRole_canary1";
  assert.ok(!KNOWN_PI_ROLES.has(ROLE), "test role must be unknown to snorrio");

  let out: any[] = [];
  const writes = captureStderr(() => {
    out = normalizeSessionMessages([
      { role: "user", content: "hi" },
      { role: ROLE, content: "some salvageable text", timestamp: 1 }, // has text -> salvaged as user
      { role: ROLE, customField: 42, timestamp: 2 },                  // no content -> dropped
      { role: ROLE, content: "more text", timestamp: 3 },             // 2nd salvage, same role
    ] as any);
  });

  // The unknown role NEVER reaches the wire as itself.
  assert.ok(out.every((m) => m.role !== ROLE), "unknown role not emitted raw");
  // Salvaged messages are normalized to a real conversational role.
  assert.ok(out.every((m) => KNOWN_PI_ROLES.has(m.role)), "every emitted role is known");
  // The content-less unknown message was dropped (1 user + 2 salvaged = 3).
  assert.equal(out.length, 3, "content-less unknown message dropped, text-bearing ones salvaged");

  // Warned exactly ONCE for the distinct role despite 3 unknown messages.
  const warns = writes.filter((w) => w.includes(ROLE));
  assert.equal(warns.length, 1, "warn-once per distinct role (deduped across messages)");
  assert.match(warns[0], new RegExp(`unknown session role '${ROLE}'`));
  assert.match(warns[0], /normalizeSessionMessages\/KNOWN_PI_ROLES/);
});

test("allowlist-flip: conversational roles + toolResult pass through with all fields (the load-bearing case)", () => {
  const raw = [
    { role: "user", content: "q", timestamp: 1 },
    { role: "assistant", content: [{ type: "text", text: "a" }], provider: "anthropic", api: "anthropic-messages", model: "claude-opus", timestamp: 2 },
    // Real pi toolResult uses toolCallId; tool_use_id is the Anthropic wire field
    // whose loss caused the 47251a1 provider 400. Both must survive the spread.
    { role: "toolResult", toolCallId: "call_123", tool_use_id: "tu_123", toolName: "bash", content: [{ type: "text", text: "out" }], isError: false, timestamp: 3 },
  ];

  let out: any[] = [];
  const writes = captureStderr(() => { out = normalizeSessionMessages(raw as any); });

  assert.equal(out.length, 3, "all conversational turns survive");
  assert.equal(writes.length, 0, "no spurious unknown-role warnings for real roles");

  const tr = out.find((m) => m.role === "toolResult") as any;
  assert.ok(tr, "toolResult role preserved, not normalized away");
  assert.equal(tr.toolCallId, "call_123", "toolCallId survives the spread");
  assert.equal(tr.tool_use_id, "tu_123", "tool_use_id survives the spread (47251a1 bug guard)");
  assert.equal(tr.toolName, "bash", "other tool linkage fields survive");

  const asst = out.find((m) => m.role === "assistant") as any;
  assert.equal(asst.provider, "anthropic", "provider survives for downstream thinking transforms");
  assert.equal(asst.api, "anthropic-messages", "api survives");
  assert.equal(asst.model, "claude-opus", "model survives");
});

test("allowlist-flip: custom honors excludeFromContext consistently with bashExecution", () => {
  const raw = [
    { role: "custom", customType: "note", content: "visible note", display: true, timestamp: 1 },
    { role: "custom", customType: "secretNote", content: "hidden note", excludeFromContext: true, timestamp: 2 },
    { role: "bashExecution", command: "ls", output: "a", excludeFromContext: true, timestamp: 3 },
  ];
  const out = normalizeSessionMessages(raw as any);
  const text = out.map((m) => (typeof m.content === "string" ? m.content : "")).join("\n");
  assert.match(text, /visible note/, "non-hidden custom kept");
  assert.doesNotMatch(text, /hidden note/, "excludeFromContext custom dropped (now consistent with bash)");
  assert.equal(out.length, 1, "both excluded control messages dropped");
});

test("sessionMessagesToLlm: composes normalization + readable-thinking", () => {
  const raw = [
    { role: "assistant", content: [
      { type: "thinking", thinking: "private reasoning", thinkingSignature: "sig" },
      { type: "text", text: "answer" },
    ] },
    { role: "compactionSummary", summary: "older context", tokensBefore: 1, timestamp: 1 },
  ];

  const out = sessionMessagesToLlm(raw as any);

  // Thinking signature is gone; reasoning rendered as <thinking> text.
  const flat = out.filter((m) => Array.isArray(m.content)).flatMap((m) => m.content as any[]);
  assert.ok(!flat.some((b: any) => b && "thinkingSignature" in b), "no signature reaches the wire");
  assert.ok(
    flat.some((b: any) => b?.type === "text" && b.text.startsWith("<thinking>")),
    "reasoning rendered readable",
  );
  // And the compaction summary was narrowed to a content-bearing user turn.
  assert.ok(
    out.some((m) => m.role === "user" && typeof m.content === "string" && m.content.includes("older context")),
    "compaction summary narrowed to user text",
  );
});
