#!/usr/bin/env node
// Snorrio AI — LLM calls via pi-ai.
//
// Uses pi's model resolution, auth, and provider system.
// Config override via ~/snorrio/config/config.json.
//
// Usage:
//   import { complete, stream } from "./ai.ts";
//   const result = await complete(messages, systemPrompt, modelSpec);

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";
import { realpathSync } from "fs";
import { fileURLToPath } from "url";

// --- Types ---

interface SnorrioConfig {
  provider?: string | null;
  model?: string;
  timezone?: string | null;
  providerPreference?: string[];
  tools?: Record<string, { model?: string; provider?: string }>;
}

interface PiSettings {
  defaultProvider?: string;
  defaultModel?: string;
}

interface Model {
  provider: string;
  id: string;
  [key: string]: any;
}

export interface Resolved {
  model: Model;
  apiKey: string;
}

export interface Message {
  role: string;
  // Required. pi's buildSessionContext() yields the broader AgentMessage union
  // (control messages with no `content`), but those never reach here raw:
  // sessionMessagesToLlm() in model-independence.ts narrows them to content-
  // bearing Messages at snorrio's owned session-read boundary. Everything that
  // hits complete()/stream() is a real, content-bearing LLM message.
  content: string | any[];
  timestamp?: number;
}

interface CompletionResult {
  stopReason?: string;
  errorMessage?: string;
  content?: Array<{ type: string; text?: string }>;
}

// --- Pi detection ---

function hasPi(): boolean {
  try {
    execSync("which pi", { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch { return false; }
}

// --- Lazy pi discovery ---

let _piRoot: string | null | undefined = undefined;

function findPiRoot(): string | null {
  if (!hasPi()) return null;
  try {
    const piBin = execSync("which pi", { encoding: "utf8", stdio: "pipe" }).trim();
    const realBin = realpathSync(piBin);
    return realBin.replace(/\/dist\/.*$/, "");
  } catch {
    try {
      const globalRoot = execSync("npm root -g", { encoding: "utf8", stdio: "pipe" }).trim();
      // pi-coding-agent was published under @mariozechner, then renamed to
      // @earendil-works. Prefer the new scope, fall back to the old one.
      for (const scope of ["@earendil-works/pi-coding-agent", "@mariozechner/pi-coding-agent"]) {
        const candidate = join(globalRoot, scope);
        if (existsSync(candidate)) return candidate;
      }
    } catch {}
  }
  return null;
}

export function piRoot(): string | null {
  if (_piRoot === undefined) _piRoot = findPiRoot();
  return _piRoot;
}

// Dynamic pi-ai imports — only attempted when pi is available
let _piAi: any, _piOauth: any, _piAgent: any;

// pi-ai was published under @mariozechner, then renamed to @earendil-works.
// Try the new scope first, fall back to the old one.
async function importPiAi(root: string, sub: string) {
  for (const scope of ["@earendil-works/pi-ai", "@mariozechner/pi-ai"]) {
    const p = join(root, "node_modules", scope, sub);
    if (existsSync(p)) return import(p);
  }
  throw new Error(`pi-ai not found (looked for ${sub} under both scopes)`);
}

async function getPiAi() {
  if (!_piAi) {
    const root = piRoot();
    if (!root) throw new Error("pi not installed");
    _piAi = await importPiAi(root, "dist/index.js");
  }
  return _piAi;
}

async function getPiOauth() {
  if (!_piOauth) {
    const root = piRoot();
    if (!root) throw new Error("pi not installed");
    _piOauth = await importPiAi(root, "dist/oauth.js");
  }
  return _piOauth;
}

async function getPiAgent() {
  if (!_piAgent) {
    const root = piRoot();
    if (!root) throw new Error("pi not installed");
    _piAgent = await import(join(root, "dist/index.js"));
  }
  return _piAgent;
}

// --- Snorrio paths ---

export const HOME = process.env.HOME!;
const FILE_PATH = fileURLToPath(import.meta.url);
export const PKG_ROOT = join(dirname(FILE_PATH), "..");
export const SNORRIO_HOME = process.env.SNORRIO_HOME || join(HOME, "snorrio");

// --- Config ---

export const CONFIG_DIR = join(SNORRIO_HOME, "config");
export const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PI_SETTINGS_PATH = join(HOME, ".pi/agent/settings.json");

const MODEL_ALIASES: Record<string, Record<string, string>> = {
  opus: {
    "anthropic": "claude-opus-4-6",
    "github-copilot": "claude-opus-4.6",
  },
  sonnet: {
    "anthropic": "claude-sonnet-4-6",
    "github-copilot": "claude-sonnet-4.6",
  },
  haiku: {
    "anthropic": "claude-haiku-4-5",
    "github-copilot": "claude-haiku-4.5",
  },
};

const DEFAULT_PROVIDER_PREFERENCE = ["anthropic", "github-copilot", "openai-codex"];

function getProviderPreference(): string[] {
  const config = loadConfig();
  return config.providerPreference || DEFAULT_PROVIDER_PREFERENCE;
}

function loadConfig(): SnorrioConfig {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function loadPiSettings(): PiSettings {
  try {
    return JSON.parse(readFileSync(PI_SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

// --- Auth (pi backend only) ---

let _authStorage: any;

async function getAuthStorage() {
  if (!_authStorage) {
    const { AuthStorage } = await getPiAgent();
    _authStorage = AuthStorage.create();
  }
  return _authStorage;
}

async function hasAuth(provider: string): Promise<boolean> {
  const auth = await getAuthStorage();
  return auth.hasAuth(provider);
}

async function getApiKey(provider: string): Promise<string> {
  const auth = await getAuthStorage();
  return auth.getApiKey(provider);
}

// --- Model Resolution (pi backend) ---

async function applyProviderModifications(model: Model): Promise<Model> {
  const auth = await getAuthStorage();
  const cred = auth.get(model.provider);
  if (cred?.type !== "oauth") return model;

  const oauth = await getPiOauth();
  const oauthProvider = oauth.getOAuthProvider(model.provider);
  if (!oauthProvider?.modifyModels) return model;

  const [modified] = oauthProvider.modifyModels([model], cred);
  return modified;
}

export async function resolveModel(spec: string | null = null, toolName: string | null = null): Promise<Resolved> {
  const config = loadConfig();
  const piAi = await getPiAi();

  const effectiveSpec = spec
    || config.tools?.[toolName!]?.model
    || config.model
    || null;

  const effectiveProvider = (effectiveSpec?.includes("/") ? effectiveSpec.split("/")[0] : null)
    || config.tools?.[toolName!]?.provider
    || config.provider
    || loadPiSettings().defaultProvider
    || null;

  let model: Model | undefined;

  if (effectiveSpec?.includes("/")) {
    const [provider, modelId] = effectiveSpec.split("/", 2);
    model = piAi.getModel(provider, modelId);
    if (!model) throw new Error(`Model not found: ${effectiveSpec}`);

  } else if (effectiveSpec && MODEL_ALIASES[effectiveSpec]) {
    model = await resolveAlias(effectiveSpec, effectiveProvider, piAi);

  } else if (effectiveSpec) {
    if (effectiveProvider) {
      model = piAi.getModel(effectiveProvider, effectiveSpec);
    }
    if (!model) {
      for (const p of getProviderPreference()) {
        model = piAi.getModel(p, effectiveSpec);
        if (model) break;
      }
    }
    if (!model) throw new Error(`Model not found: ${effectiveSpec}`);

  } else {
    const piSettings = loadPiSettings();
    const provider = piSettings.defaultProvider;
    const modelId = piSettings.defaultModel;
    if (!provider || !modelId) {
      throw new Error("No model specified and no pi default configured. Run pi and select a model, or set model in ~/snorrio/config/config.json");
    }
    model = piAi.getModel(provider, modelId);
    if (!model) throw new Error(`Pi's default model not found: ${provider}/${modelId}`);
  }

  model = await applyProviderModifications(model);

  const apiKey = await getApiKey(model.provider);
  if (!apiKey) {
    throw new Error(`No auth configured for provider '${model.provider}'. Run: pi then /login`);
  }

  return { model, apiKey };
}

async function resolveAlias(alias: string, preferredProvider: string | null, piAi: any): Promise<Model> {
  const providerMap = MODEL_ALIASES[alias];
  if (!providerMap) throw new Error(`Unknown alias: ${alias}`);

  if (preferredProvider && providerMap[preferredProvider]) {
    if (await hasAuth(preferredProvider)) {
      const model = piAi.getModel(preferredProvider, providerMap[preferredProvider]);
      if (model) return model;
    }
  }

  for (const provider of getProviderPreference()) {
    if (!providerMap[provider]) continue;
    if (await hasAuth(provider)) {
      const model = piAi.getModel(provider, providerMap[provider]);
      if (model) return model;
    }
  }

  const providers = Object.keys(providerMap).join(", ");
  throw new Error(`No auth available for '${alias}'. Need credentials for one of: ${providers}. Run: pi then /login`);
}

// --- LLM Calls ---

// Env-gated timing instrumentation (SNORRIO_AI_TIMING=1). Default off, no behavior change.
// Partitions a call into resolve+auth (our toolchain) vs TTFT/stream throughput (provider),
// so a "stall" can be attributed to the right layer. Writes to stderr.
const _AI_TIMING = process.env.SNORRIO_AI_TIMING === "1";
const _AI_TAG = process.env.SNORRIO_AI_TAG || `${process.pid}`;
function _tlog(phase: string, info: string) {
  if (_AI_TIMING) process.stderr.write(`[AI-TIMING ${new Date().toISOString()} tag=${_AI_TAG}] ${phase} ${info}\n`);
}

async function piComplete(messages: Message[], systemPrompt: string, modelSpec: string | null, toolName: string | null, options: Record<string, any> = {}): Promise<CompletionResult> {
  const t0 = Date.now();
  const resolved = await resolveModel(modelSpec, toolName);
  const piAi = await getPiAi();
  _tlog("resolve+auth", `${Date.now() - t0}ms model=${resolved.model.provider}/${resolved.model.id}`);
  const tApi = Date.now();
  const result = await piAi.completeSimple(
    resolved.model,
    { systemPrompt, messages },
    { apiKey: resolved.apiKey, ...options },
  );
  _tlog("complete-done", `apiMs=${Date.now() - tApi} totalMs=${Date.now() - t0} stop=${(result as any)?.stopReason}`);
  return result;
}

async function* piStream(messages: Message[], systemPrompt: string, modelSpec: string | null, toolName: string | null, options: Record<string, any> = {}): AsyncGenerator<any> {
  const t0 = Date.now();
  const resolved = await resolveModel(modelSpec, toolName);
  const piAi = await getPiAi();
  _tlog("resolve+auth", `${Date.now() - t0}ms model=${resolved.model.provider}/${resolved.model.id}`);
  const tStream = Date.now();
  const eventStream = piAi.streamSimple(
    resolved.model,
    { systemPrompt, messages },
    { apiKey: resolved.apiKey, ...options },
  );
  let n = 0, first = 0, last = tStream, maxgap = 0;
  for await (const event of eventStream) {
    const now = Date.now();
    if (!first) { first = now; _tlog("TTFT", `${now - tStream}ms (first stream event)`); }
    const gap = now - last; if (gap > maxgap) maxgap = gap; last = now;
    n++;
    yield event;
  }
  _tlog("stream-done", `events=${n} ttftMs=${first ? first - tStream : -1} streamMs=${Date.now() - tStream} maxGapMs=${maxgap} totalMs=${Date.now() - t0}`);
}

// --- Public API ---

export async function complete(messages: Message[], systemPrompt: string, modelSpec: string | null = null, toolName: string | null = null, options: Record<string, any> = {}): Promise<CompletionResult> {
  return piComplete(messages, systemPrompt, modelSpec, toolName, options);
}

export async function* stream(messages: Message[], systemPrompt: string, modelSpec: string | null = null, toolName: string | null = null, options: Record<string, any> = {}): AsyncGenerator<any> {
  yield* piStream(messages, systemPrompt, modelSpec, toolName, options);
}

// --- Config Management ---

export function ensureConfig(): void {
  try {
    readFileSync(CONFIG_PATH);
  } catch {
    const defaultConfig = {
      provider: null,
      model: "opus",
      timezone: null,
      tools: {},
    };
    mkdirSync(CONFIG_DIR, { recursive: true });
    writeFileSync(CONFIG_PATH, JSON.stringify(defaultConfig, null, 2) + "\n");
  }
}

// --- Timezone ---

export function getTimezone(): string {
  const config = loadConfig();
  return config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// --- Utilities ---

export function getText(message: CompletionResult | null): string {
  if (!message?.content) return "";
  return message.content
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("");
}

export function userMessage(content: string): Message {
  return { role: "user", content, timestamp: Date.now() };
}
