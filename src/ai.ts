#!/usr/bin/env node
// Snorrio AI — LLM calls via pi-ai.
//
// Uses pi's model resolution, auth, and provider system.
// Config override via ~/.config/snorrio/config.json.
//
// Usage:
//   import { complete, stream } from "./ai.ts";
//   const result = await complete(messages, systemPrompt, modelSpec);

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { execSync } from "child_process";
import { realpathSync } from "fs";

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

interface Message {
  role: string;
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
      const candidate = join(globalRoot, "@mariozechner/pi-coding-agent");
      if (existsSync(candidate)) return candidate;
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

async function getPiAi() {
  if (!_piAi) {
    const root = piRoot();
    if (!root) throw new Error("pi not installed");
    _piAi = await import(join(root, "node_modules/@mariozechner/pi-ai/dist/index.js"));
  }
  return _piAi;
}

async function getPiOauth() {
  if (!_piOauth) {
    const root = piRoot();
    if (!root) throw new Error("pi not installed");
    _piOauth = await import(join(root, "node_modules/@mariozechner/pi-ai/dist/oauth.js"));
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

export const SNORRIO_HOME = process.env.SNORRIO_HOME || join(process.env.HOME!, "snorrio");

// --- Config ---

const CONFIG_DIR = join(process.env.HOME!, ".config/snorrio");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PI_SETTINGS_PATH = join(process.env.HOME!, ".pi/agent/settings.json");

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
      throw new Error("No model specified and no pi default configured. Run pi and select a model, or set model in ~/.config/snorrio/config.json");
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

async function piComplete(messages: Message[], systemPrompt: string, modelSpec: string | null, toolName: string | null, options: Record<string, any> = {}): Promise<CompletionResult> {
  const resolved = await resolveModel(modelSpec, toolName);
  const piAi = await getPiAi();
  return piAi.completeSimple(
    resolved.model,
    { systemPrompt, messages },
    { apiKey: resolved.apiKey, ...options },
  );
}

async function* piStream(messages: Message[], systemPrompt: string, modelSpec: string | null, toolName: string | null, options: Record<string, any> = {}): AsyncGenerator<any> {
  const resolved = await resolveModel(modelSpec, toolName);
  const piAi = await getPiAi();
  const eventStream = piAi.streamSimple(
    resolved.model,
    { systemPrompt, messages },
    { apiKey: resolved.apiKey, ...options },
  );
  yield* eventStream;
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
