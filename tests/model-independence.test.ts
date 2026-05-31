import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { toReadableThinking, dropForeignThinking, THINKING_TYPES } from "../src/model-independence.ts";

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
