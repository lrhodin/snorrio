import { test } from "node:test";
import assert from "node:assert/strict";
import { aliasProviderOrder, latestModelForFamilyRt } from "../src/ai.ts";

function runtime(models: Array<{ provider: string; id: string }>) {
  return {
    getModels(provider: string) {
      return models.filter((model) => model.provider === provider);
    },
    getProviders() {
      return [...new Set(models.map((model) => model.provider))].map((id) => ({ id }));
    },
  };
}

test("versioned family matching selects the newest trailing-version model", () => {
  const rt = runtime([
    { provider: "anthropic", id: "claude-opus-4.8" },
    { provider: "anthropic", id: "claude-opus-5" },
    { provider: "anthropic", id: "claude-sonnet-5" },
  ]);

  assert.equal(latestModelForFamilyRt(rt, "anthropic", { name: "claude-opus" })?.id, "claude-opus-5");
});

test("family matching sees through gateway id prefixes on any provider", () => {
  const rt = runtime([
    { provider: "some-gateway", id: "anthropic/claude-opus-5" },
    { provider: "some-gateway", id: "anthropic/claude-opus-5-5" },
    { provider: "some-gateway", id: "bedrock/anthropic.claude-haiku-4-5" },
    { provider: "some-gateway", id: "bedrock/openai.gpt-5.6-sol" },
    { provider: "some-gateway", id: "bedrock/openai.gpt-6-sol" },
    { provider: "some-gateway", id: "bedrock/openaiXgpt-9.9-sol" },
    { provider: "some-gateway", id: "bedrock/openai.gpt-9.9-terra" },
  ]);

  assert.equal(latestModelForFamilyRt(rt, "some-gateway", { name: "claude-opus" })?.id, "anthropic/claude-opus-5-5");
  assert.equal(latestModelForFamilyRt(rt, "some-gateway", { name: "claude-haiku" })?.id, "bedrock/anthropic.claude-haiku-4-5");
  assert.equal(latestModelForFamilyRt(rt, "some-gateway", { name: "gpt", suffix: "sol" })?.id, "bedrock/openai.gpt-6-sol");
});

test("Sol family matching supports OpenAI Codex model IDs", () => {
  const rt = runtime([
    { provider: "openai-codex", id: "gpt-5.5-sol" },
    { provider: "openai-codex", id: "gpt-5.6-sol" },
  ]);

  assert.equal(latestModelForFamilyRt(rt, "openai-codex", { name: "gpt", suffix: "sol" })?.id, "gpt-5.6-sol");
});

test("alias provider order: preferred, then preference, then every other registered provider", () => {
  const rt = runtime([
    { provider: "zeta", id: "x" },
    { provider: "anthropic", id: "x" },
    { provider: "alpha", id: "x" },
  ]);

  assert.deepEqual(aliasProviderOrder(rt, "zeta", ["anthropic", "github-copilot"]), ["zeta", "anthropic", "alpha"]);
  assert.deepEqual(aliasProviderOrder(rt, null, ["anthropic"]), ["anthropic", "alpha", "zeta"]);
});
