import { test } from "node:test";
import assert from "node:assert/strict";
import { latestModelForFamilyRt } from "../src/ai.ts";

function runtime(models: Array<{ provider: string; id: string }>) {
  return {
    getModels(provider: string) {
      return models.filter((model) => model.provider === provider);
    },
  };
}

test("versioned family matching selects the newest trailing-version model", () => {
  const rt = runtime([
    { provider: "anthropic", id: "claude-opus-4.8" },
    { provider: "anthropic", id: "claude-opus-5" },
    { provider: "anthropic", id: "claude-sonnet-5" },
  ]);

  assert.equal(latestModelForFamilyRt(rt, "anthropic", "claude-opus")?.id, "claude-opus-5");
});

test("Sol family matching supports OpenAI Codex and Bifrost model IDs", () => {
  const rt = runtime([
    { provider: "openai-codex", id: "gpt-5.5-sol" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
    { provider: "bifrost-gpt", id: "bedrock/openai.gpt-5.5-sol" },
    { provider: "bifrost-gpt", id: "bedrock/openai.gpt-5.6-sol" },
    { provider: "bifrost-gpt", id: "bedrock/openaiXgpt-9.9-sol" },
  ]);

  assert.equal(
    latestModelForFamilyRt(rt, "openai-codex", { prefix: "gpt", suffix: "sol" })?.id,
    "gpt-5.6-sol",
  );
  assert.equal(
    latestModelForFamilyRt(rt, "bifrost-gpt", { prefix: "bedrock/openai.gpt", suffix: "sol" })?.id,
    "bedrock/openai.gpt-5.6-sol",
  );
});
