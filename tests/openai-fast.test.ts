import { test } from "node:test";
import assert from "node:assert/strict";
import extension, { parseConfig, priorityPayload, supportsFast } from "../extensions/openai-fast.ts";
import { mkdtempSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const model = { provider: "openai-codex", id: "gpt-6-astra", api: "openai-codex-responses" };

test("exact explicit config validation", () => {
  assert.deepEqual(parseConfig({ models: ["openai-codex/gpt-6-astra"] }).models, ["openai-codex/gpt-6-astra"]);
  for (const value of [null, [], {}, { models: [1] }, { models: ["anthropic/foo"] }]) assert.throws(() => parseConfig(value));
});
test("priority rewrite preserves reasoning and original payload", () => {
  const payload = { reasoning: { effort: "low" }, service_tier: "auto", input: [] };
  assert.deepEqual(priorityPayload(payload, model, true), { ...payload, service_tier: "priority" });
  assert.equal(payload.service_tier, "auto");
  assert.equal(priorityPayload(payload, model, false), undefined);
  for (const p of [null, [], "bad"]) assert.equal(priorityPayload(p, model, true), undefined);
});
test("provider and API allowlist excludes compatible third parties", () => {
  for (const provider of ["openrouter", "azure-openai", "anthropic"]) assert.equal(supportsFast({ ...model, provider }), false);
  assert.equal(supportsFast({ ...model, api: "anthropic-messages" }), false);
  assert.equal(supportsFast(undefined), false);
  assert.equal(supportsFast({ ...model, provider: "openai", api: "openai-responses" }), true);
});
test("extension lifecycle, model-scoped toggle, reset and malformed config", async () => {
  const dir = mkdtempSync(join(tmpdir(), "openai-fast-"));
  const old = process.env.PI_OPENAI_FAST_CONFIG;
  process.env.PI_OPENAI_FAST_CONFIG = join(dir, "config.json");
  try {
    const handlers: Record<string, Function> = {};
    let command: any;
    const notices: string[] = [];
    const ctx: any = { model, ui: { setStatus() {}, notify(s: string) { notices.push(s); } } };
    extension({ on: (name: string, fn: Function) => { handlers[name] = fn; }, registerCommand: (_: string, c: any) => { command = c; } } as any);
    const request = () => handlers.before_provider_request({ payload: { reasoning: { effort: "low" } } }, ctx);
    handlers.session_start({}, ctx);
    assert.equal(request(), undefined);
    writeFileSync(process.env.PI_OPENAI_FAST_CONFIG!, JSON.stringify({ models: ["openai-codex/gpt-6-astra"] }));
    handlers.session_start({}, ctx);
    assert.equal(request().service_tier, "priority");
    await command.handler("off", ctx);
    assert.equal(request(), undefined);
    await command.handler("on", ctx);
    ctx.model = { ...model, id: "other" };
    assert.equal(request(), undefined);
    ctx.model = model;
    assert.equal(request().reasoning.effort, "low");
    await command.handler("off", ctx);
    handlers.session_start({}, ctx);
    assert.equal(request().service_tier, "priority");
    writeFileSync(process.env.PI_OPENAI_FAST_CONFIG!, "bad json");
    handlers.session_start({}, ctx);
    assert.equal(request(), undefined);
    assert.ok(notices.some(s => s.includes("disabled")));
  } finally {
    if (old === undefined) delete process.env.PI_OPENAI_FAST_CONFIG; else process.env.PI_OPENAI_FAST_CONFIG = old;
    rmSync(dir, { recursive: true });
  }
});
