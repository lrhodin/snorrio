#!/usr/bin/env node
// Snorrio AI — shared model resolution and LLM calls.
//
// Resolves models across providers (Anthropic, GitHub Copilot, etc.) using:
//   1. Explicit CLI override (provider/model or alias)
//   2. Per-tool config from ~/.config/snorrio/config.json
//   3. Global config default
//   4. Pi's current model from settings
//
// Usage:
//   import { resolveModel, complete } from "./ai.mjs";
//   const model = await resolveModel(cliArg, "dmn");
//   const result = await complete(model, messages, systemPrompt);

import { readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { execSync } from "child_process";
import { realpathSync } from "fs";

// --- Pi package discovery ---

function findPiRoot() {
  try {
    const piBin = execSync("which pi", { encoding: "utf8" }).trim();
    const realBin = realpathSync(piBin);
    return realBin.replace(/\/dist\/.*$/, "");
  } catch {
    // Fallback: npm global root
    const globalRoot = execSync("npm root -g", { encoding: "utf8" }).trim();
    return join(globalRoot, "@mariozechner/pi-coding-agent");
  }
}

const PI_ROOT = findPiRoot();
const PI_AI = join(PI_ROOT, "node_modules/@mariozechner/pi-ai/dist/index.js");
const PI_OAUTH = join(PI_ROOT, "node_modules/@mariozechner/pi-ai/dist/oauth.js");
const PI_AGENT = join(PI_ROOT, "dist/index.js");

// Dynamic imports (ESM)
let _piAi, _piOauth, _piAgent;

async function getPiAi() {
  if (!_piAi) _piAi = await import(PI_AI);
  return _piAi;
}

async function getPiOauth() {
  if (!_piOauth) _piOauth = await import(PI_OAUTH);
  return _piOauth;
}

async function getPiAgent() {
  if (!_piAgent) _piAgent = await import(PI_AGENT);
  return _piAgent;
}

// --- Snorrio paths ---

export const SNORRIO_HOME = process.env.SNORRIO_HOME || join(process.env.HOME, ".snorrio");

export function piRoot() { return PI_ROOT; }

// --- Config ---

const CONFIG_DIR = join(process.env.HOME, ".config/snorrio");
const CONFIG_PATH = join(CONFIG_DIR, "config.json");
const PI_SETTINGS_PATH = join(process.env.HOME, ".pi/agent/settings.json");

// Model aliases — map short names to model IDs per provider.
const MODEL_ALIASES = {
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

// Provider preference order for alias resolution.
// Configurable via ~/.config/snorrio/config.json `providerPreference` array.
const DEFAULT_PROVIDER_PREFERENCE = ["anthropic", "github-copilot", "openai-codex"];

function getProviderPreference() {
  const config = loadConfig();
  return config.providerPreference || DEFAULT_PROVIDER_PREFERENCE;
}

function loadConfig() {
  try {
    return JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
  } catch {
    return {};
  }
}

function loadPiSettings() {
  try {
    return JSON.parse(readFileSync(PI_SETTINGS_PATH, "utf8"));
  } catch {
    return {};
  }
}

// --- Auth ---

let _authStorage;

async function getAuthStorage() {
  if (!_authStorage) {
    const { AuthStorage } = await getPiAgent();
    _authStorage = AuthStorage.create();
  }
  return _authStorage;
}

async function hasAuth(provider) {
  const auth = await getAuthStorage();
  return auth.hasAuth(provider);
}

async function getApiKey(provider) {
  const auth = await getAuthStorage();
  return auth.getApiKey(provider);
}

// --- Model Resolution ---

async function applyProviderModifications(model) {
  const auth = await getAuthStorage();
  const cred = auth.get(model.provider);
  if (cred?.type !== "oauth") return model;

  const oauth = await getPiOauth();
  const oauthProvider = oauth.getOAuthProvider(model.provider);
  if (!oauthProvider?.modifyModels) return model;

  const [modified] = oauthProvider.modifyModels([model], cred);
  return modified;
}

export async function resolveModel(spec = null, toolName = null) {
  const config = loadConfig();
  const piAi = await getPiAi();

  const effectiveSpec = spec
    || config.tools?.[toolName]?.model
    || config.model
    || null;

  const effectiveProvider = (effectiveSpec?.includes("/") ? effectiveSpec.split("/")[0] : null)
    || config.tools?.[toolName]?.provider
    || config.provider
    || loadPiSettings().defaultProvider
    || null;

  let model;

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

async function resolveAlias(alias, preferredProvider, piAi) {
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

export async function complete(resolved, messages, systemPrompt, options = {}) {
  const piAi = await getPiAi();
  return piAi.completeSimple(
    resolved.model,
    { systemPrompt, messages },
    { apiKey: resolved.apiKey, ...options },
  );
}

export function stream(resolved, messages, systemPrompt, options = {}) {
  if (!_piAi) throw new Error("Call resolveModel() before stream()");
  return _piAi.streamSimple(
    resolved.model,
    { systemPrompt, messages },
    { apiKey: resolved.apiKey, ...options },
  );
}

export async function completeWithTools(resolved, messages, systemPrompt, tools, options = {}) {
  const piAi = await getPiAi();
  return piAi.completeSimple(
    resolved.model,
    { systemPrompt, messages, tools },
    { apiKey: resolved.apiKey, ...options },
  );
}

// --- Config Management ---

export function ensureConfig() {
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

export function getTimezone() {
  const config = loadConfig();
  return config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
}

// --- Utilities ---

export function getText(message) {
  if (!message?.content) return "";
  return message.content
    .filter(c => c.type === "text")
    .map(c => c.text)
    .join("");
}

export function userMessage(content) {
  return { role: "user", content, timestamp: Date.now() };
}
