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

// --- Pi runtime (ModelRuntime via createAgentSessionServices) ---
//
// pi-ai's old top-level surface (getModel/getModels/complete/stream) and
// coding-agent's AuthStorage were removed. Model resolution, provider auth,
// and completion now live behind a single `Models` implementation:
// ModelRuntime. We obtain one via createAgentSessionServices() so that
// extension-registered providers (e.g. a bifrost gateway) and their auth are
// loaded exactly as they are for an interactive pi session — snorrio sees the
// same models the user does.
let _piAgent: any;
let _runtime: any;
let _runtimePromise: Promise<any> | null = null;

async function getPiAgent() {
  if (!_piAgent) {
    const root = piRoot();
    if (!root) throw new Error("pi not installed");
    _piAgent = await import(join(root, "dist/index.js"));
  }
  return _piAgent;
}

// Cached, single-flight ModelRuntime. cwd only affects project-scoped
// resource loading (context files, project extensions); the daemon has no
// meaningful project cwd, so we use SNORRIO_HOME. Provider registrations from
// user-global extensions load regardless of cwd.
async function getRuntime(): Promise<any> {
  if (_runtime) return _runtime;
  if (!_runtimePromise) {
    _runtimePromise = (async () => {
      const agent = await getPiAgent();
      const cwd = process.env.SNORRIO_RUNTIME_CWD || SNORRIO_HOME || process.cwd();
      const services = await agent.createAgentSessionServices({ cwd });
      _runtime = services.modelRuntime;
      return _runtime;
    })();
  }
  return _runtimePromise;
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

// Aliases map a model *type* to a family prefix per provider — NOT a pinned
// version. resolveAlias() picks the newest available version of that family
// from pi-ai's registry, so "opus"/"fable" always track the latest release and
// version numbers never have to be hand-edited here. (See latestModelForFamily.)
const MODEL_ALIASES: Record<string, Record<string, string>> = {
  opus: {
    "anthropic": "claude-opus",
    "github-copilot": "claude-opus",
  },
  sonnet: {
    "anthropic": "claude-sonnet",
    "github-copilot": "claude-sonnet",
  },
  haiku: {
    "anthropic": "claude-haiku",
    "github-copilot": "claude-haiku",
  },
  fable: {
    "anthropic": "claude-fable",
    "github-copilot": "claude-fable",
  },
};

// Compare two numeric version tuples (e.g. [4,8] vs [4,7]); missing trailing
// components count as 0 so [4,8] > [4].
function compareVersion(a: number[], b: number[]): number {
  const n = Math.max(a.length, b.length);
  for (let i = 0; i < n; i++) {
    const d = (a[i] ?? 0) - (b[i] ?? 0);
    if (d !== 0) return d;
  }
  return 0;
}

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

// --- Auth / availability (via ModelRuntime) ---

// Whether a provider has usable auth. The runtime resolves stored credentials,
// ambient env keys, extension-supplied apiKeys, and OAuth uniformly.
async function hasAuth(provider: string): Promise<boolean> {
  const rt = await getRuntime();
  try {
    return rt.hasConfiguredAuth(provider);
  } catch {
    return false;
  }
}

// --- Model Resolution (pi backend) ---

// Resolve a family prefix to the newest concrete model for a provider, using
// the runtime's model list (built-in + extension-registered providers).
function latestModelForFamilyRt(rt: any, provider: string, family: string): Model | undefined {
  const re = new RegExp(`^${family}[-.]([0-9]+(?:[-.][0-9]+)*)$`);
  let best: { model: Model; ver: number[] } | undefined;
  for (const model of (rt.getModels(provider) as Model[])) {
    const m = model.id.match(re);
    if (!m) continue;
    const ver = m[1].split(/[-.]/).map(Number);
    if (ver.some(n => !Number.isFinite(n) || n >= 1000)) continue;
    if (!best || compareVersion(ver, best.ver) > 0) best = { model, ver };
  }
  return best?.model;
}

export async function resolveModel(spec: string | null = null, toolName: string | null = null): Promise<Resolved> {
  const config = loadConfig();
  const rt = await getRuntime();

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
    // provider/modelId. modelId may itself contain "/" (e.g. bifrost's
    // "bedrock/us.anthropic.claude-opus-4-8"), so split only on the first "/".
    const slash = effectiveSpec.indexOf("/");
    const provider = effectiveSpec.slice(0, slash);
    const modelId = effectiveSpec.slice(slash + 1);
    model = rt.getModel(provider, modelId);
    if (!model) throw new Error(`Model not found: ${effectiveSpec}`);

  } else if (effectiveSpec && MODEL_ALIASES[effectiveSpec]) {
    model = await resolveAlias(effectiveSpec, effectiveProvider, rt);

  } else if (effectiveSpec) {
    if (effectiveProvider) {
      model = rt.getModel(effectiveProvider, effectiveSpec);
    }
    if (!model) {
      for (const p of getProviderPreference()) {
        model = rt.getModel(p, effectiveSpec);
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
    model = rt.getModel(provider, modelId);
    if (!model) throw new Error(`Pi's default model not found: ${provider}/${modelId}`);
  }

  if (!rt.hasConfiguredAuth(model.provider)) {
    throw new Error(`No auth configured for provider '${model.provider}'. Run: pi then /login`);
  }

  // apiKey no longer flows through snorrio: ModelRuntime.complete/stream
  // resolve and inject auth internally (stored creds, ambient env, OAuth
  // refresh, extension apiKeys). Kept on Resolved for backward compatibility.
  return { model, apiKey: "" };
}

async function resolveAlias(alias: string, preferredProvider: string | null, rt: any): Promise<Model> {
  const providerMap = MODEL_ALIASES[alias];
  if (!providerMap) throw new Error(`Unknown alias: ${alias}`);

  if (preferredProvider && providerMap[preferredProvider]) {
    if (await hasAuth(preferredProvider)) {
      const model = latestModelForFamilyRt(rt, preferredProvider, providerMap[preferredProvider]);
      if (model) return model;
    }
  }

  for (const provider of getProviderPreference()) {
    if (!providerMap[provider]) continue;
    if (await hasAuth(provider)) {
      const model = latestModelForFamilyRt(rt, provider, providerMap[provider]);
      if (model) return model;
    }
  }

  const providers = Object.keys(providerMap).join(", ");
  throw new Error(`No '${alias}' model available. Need a registry match for family '${alias}' on one of: ${providers} (and auth). Run: pi then /login`);
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
  const rt = await getRuntime();
  _tlog("resolve+auth", `${Date.now() - t0}ms model=${resolved.model.provider}/${resolved.model.id}`);
  const tApi = Date.now();
  // Use the non-simple API: pi-ai's *Simple wrappers inject `thinkingEnabled: false`
  // when no `reasoning` option is set, which becomes `thinking: {type: "disabled"}`
  // on the wire — a 400 on adaptive-thinking models (claude-fable-5+), where
  // thinking can no longer be explicitly disabled. The non-simple path omits the
  // thinking param entirely: older models default to no thinking (same behavior
  // as before), adaptive models default to adaptive. Owned boundary: snorrio
  // decides its request shape, not the wrapper. (2026-06-09)
  const result = await rt.complete(
    resolved.model,
    { systemPrompt, messages },
    options,
  );
  _tlog("complete-done", `apiMs=${Date.now() - tApi} totalMs=${Date.now() - t0} stop=${(result as any)?.stopReason}`);
  return result;
}

async function* piStream(messages: Message[], systemPrompt: string, modelSpec: string | null, toolName: string | null, options: Record<string, any> = {}): AsyncGenerator<any> {
  const t0 = Date.now();
  const resolved = await resolveModel(modelSpec, toolName);
  const rt = await getRuntime();
  _tlog("resolve+auth", `${Date.now() - t0}ms model=${resolved.model.provider}/${resolved.model.id}`);
  const tStream = Date.now();
  // Non-simple API for the same reason as piComplete: avoid the wrapper's
  // `thinkingEnabled: false` injection (400 on adaptive-thinking models).
  const eventStream = rt.stream(
    resolved.model,
    { systemPrompt, messages },
    options,
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
