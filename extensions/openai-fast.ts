// Standalone: copy this file into ~/.pi/agent/extensions; no Snorrio imports.
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent";
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

export interface FastConfig { models: string[] }
type Model = { provider: string; id: string; api: string };

export function parseConfig(value: unknown): FastConfig {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Expected an object");
  const models = (value as FastConfig).models;
  if (!Array.isArray(models) || !models.every(m => typeof m === "string" && /^(openai|openai-codex)\/[^/]+$/.test(m))) {
    throw new Error('models must contain exact openai/model or openai-codex/model IDs');
  }
  return { models: [...models] };
}

export function supportsFast(model?: Model): boolean {
  return !!model && ((model.provider === "openai-codex" && model.api === "openai-codex-responses") ||
    (model.provider === "openai" && ["openai-responses", "openai-completions"].includes(model.api)));
}

export function priorityPayload(payload: unknown, model: Model | undefined, enabled: boolean): unknown {
  if (!enabled || !supportsFast(model) || !payload || typeof payload !== "object" || Array.isArray(payload)) return;
  // Never touch reasoning, tokens, messages, or provider registration.
  return { ...payload, service_tier: "priority" };
}

export default function (pi: ExtensionAPI) {
  const path = process.env.PI_OPENAI_FAST_CONFIG || join(process.env.PI_CODING_AGENT_DIR || join(homedir(), ".pi", "agent"), "openai-fast.json");
  let config: FastConfig = { models: [] };
  // Overrides are per model and runtime only; reload/new session restores config.
  const overrides = new Map<string, boolean>();
  const key = (model: Model) => `${model.provider}/${model.id}`;
  const enabled = (model?: Model) => !!model && supportsFast(model) && (overrides.get(key(model)) ?? config.models.includes(key(model)));
  const status = (ctx: ExtensionContext) => ctx.ui.setStatus("openai-fast", enabled(ctx.model) ? "fast: priority requested" : undefined);

  pi.on("session_start", (_event, ctx) => {
    overrides.clear();
    config = { models: [] };
    try { config = parseConfig(JSON.parse(readFileSync(path, "utf8"))); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") ctx.ui.notify(`OpenAI fast disabled: ${String(error)}`, "warning");
    }
    status(ctx);
  });
  pi.on("model_select", (_event, ctx) => status(ctx));
  pi.on("before_provider_request", (event, ctx) => priorityPayload(event.payload, ctx.model, enabled(ctx.model)));
  pi.registerCommand("openai-fast", {
    description: "OpenAI priority request: on | off | status (current model, runtime only)",
    handler: async (args, ctx) => {
      const action = args.trim() || "status";
      if (!["on", "off", "status"].includes(action)) { ctx.ui.notify("Usage: /openai-fast on|off|status", "warning"); return; }
      if (!ctx.model || !supportsFast(ctx.model)) { ctx.ui.notify("OpenAI fast is unavailable for this provider/API.", "warning"); return; }
      if (action !== "status") overrides.set(key(ctx.model), action === "on");
      status(ctx);
      ctx.ui.notify(`${key(ctx.model)}: priority ${enabled(ctx.model) ? "requested (may use more quota/cost; server tier unverified)" : "not requested by this extension"}. Config: ${path}`, "info");
    },
  });
}
