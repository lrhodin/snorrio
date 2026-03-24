#!/usr/bin/env node
// Snorrio AI — dual-backend LLM calls.
//
// Two backends: pi-ai (in-process, fast) and claude CLI (subprocess).
// Auto-detects what's installed. Prefers pi-ai when both available.
// Config override via ~/.config/snorrio/config.json "backend" field.
//
// Session-level CC ops use claudeResume() which shells out to `claude --resume`.
// Everything else (temporal ops, episode gen from pi sessions) uses complete()/stream().
//
// Usage:
//   import { getBackend, complete, claudeResume } from "./ai.ts";
//   const backend = getBackend();  // "pi" | "claude"
//   const result = await complete(messages, systemPrompt, modelSpec);
//   const text = await claudeResume(sessionId, prompt, cwd);

import { readFileSync, writeFileSync, mkdirSync, existsSync } from "fs";
import { join } from "path";
import { execSync, spawn as nodeSpawn } from "child_process";
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

// --- Backend detection ---

type Backend = "pi" | "claude";

let _detectedBackend: Backend | null = null;

/** Walk the process ancestor chain looking for pi or claude. */
function detectPlatform(): Backend | null {
  try {
    let pid = process.ppid;
    for (let i = 0; i < 5 && pid > 1; i++) {
      const comm = execSync(`ps -o comm= -p ${pid}`, { encoding: "utf8", stdio: "pipe" })
        .trim().split("/").pop();
      if (comm === "pi") return "pi";
      if (comm === "claude") return "claude";
      pid = parseInt(execSync(`ps -o ppid= -p ${pid}`, { encoding: "utf8", stdio: "pipe" }).trim());
    }
  } catch {}
  return null;
}

function hasPi(): boolean {
  try {
    execSync("which pi", { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch { return false; }
}

function hasClaude(): boolean {
  try {
    execSync("which claude", { encoding: "utf8", stdio: "pipe" });
    return true;
  } catch { return false; }
}

export function getBackend(): Backend {
  if (_detectedBackend) return _detectedBackend;

  // First: check what platform we're running under
  const platform = detectPlatform();
  if (platform) { _detectedBackend = platform; return platform; }

  // Fallback for standalone processes (daemon, recall engine): check what's installed
  if (hasPi()) { _detectedBackend = "pi"; return "pi"; }
  if (hasClaude()) { _detectedBackend = "claude"; return "claude"; }

  throw new Error("No backend available. Install pi or Claude Code.");
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
  if (getBackend() !== "pi") {
    throw new Error("resolveModel() requires pi backend");
  }

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

// --- Model spec resolution for claude backend ---

function resolveModelSpec(spec: string | null, toolName: string | null): string {
  const config = loadConfig();
  return spec
    || config.tools?.[toolName!]?.model
    || config.model
    || "opus";
}

// --- LLM Calls: pi backend ---

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

// --- LLM Calls: claude backend ---

function claudeArgs(modelSpec: string, systemPrompt: string, extraArgs: string[] = []): string[] {
  return [
    "-p", "--bare",
    "--model", modelSpec,
    "--system-prompt", systemPrompt,
    "--tools", "",
    "--no-session-persistence",
    ...extraArgs,
  ];
}

async function claudeComplete(messages: Message[], systemPrompt: string, modelSpec: string | null, toolName: string | null): Promise<CompletionResult> {
  const model = resolveModelSpec(modelSpec, toolName);
  // Flatten messages into a single prompt (claude -p takes a single prompt string)
  const prompt = messages.map(m => {
    const text = typeof m.content === "string" ? m.content
      : m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    return `[${m.role}]: ${text}`;
  }).join("\n\n");

  const args = claudeArgs(model, systemPrompt);

  return new Promise((resolve, reject) => {
    const proc = nodeSpawn("claude", [...args, prompt], {
      cwd: "/",
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => stdout += d);
    proc.stderr.on("data", (d: Buffer) => stderr += d);
    proc.on("error", reject);
    proc.on("close", (code: number) => {
      if (code !== 0) {
        resolve({
          stopReason: "error",
          errorMessage: stderr || `claude exited with code ${code}`,
        });
        return;
      }
      resolve({
        stopReason: "end_turn",
        content: [{ type: "text", text: stdout }],
      });
    });
  });
}

async function* claudeStreamComplete(messages: Message[], systemPrompt: string, modelSpec: string | null, toolName: string | null): AsyncGenerator<any> {
  const model = resolveModelSpec(modelSpec, toolName);
  const prompt = messages.map(m => {
    const text = typeof m.content === "string" ? m.content
      : m.content.filter((c: any) => c.type === "text").map((c: any) => c.text).join("");
    return `[${m.role}]: ${text}`;
  }).join("\n\n");

  const args = claudeArgs(model, systemPrompt, [
    "--output-format", "stream-json",
    "--verbose",
  ]);

  const proc = nodeSpawn("claude", [...args, prompt], {
    cwd: "/",
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  let buffer = "";
  const chunks: string[] = [];

  for await (const data of proc.stdout) {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        // CC stream-json emits assistant message events with content arrays
        if (event.type === "assistant" && event.message?.content) {
          for (const block of event.message.content) {
            if (block.type === "text" && block.text) {
              yield { type: "text_delta", delta: block.text };
            }
          }
        }
      } catch {}
    }
  }
}

// --- Unified API ---

export async function complete(messages: Message[], systemPrompt: string, modelSpec: string | null = null, toolName: string | null = null, options: Record<string, any> = {}): Promise<CompletionResult> {
  const backend = getBackend();
  if (backend === "pi") {
    return piComplete(messages, systemPrompt, modelSpec, toolName, options);
  }
  return claudeComplete(messages, systemPrompt, modelSpec, toolName);
}

export async function* stream(messages: Message[], systemPrompt: string, modelSpec: string | null = null, toolName: string | null = null, options: Record<string, any> = {}): AsyncGenerator<any> {
  const backend = getBackend();
  if (backend === "pi") {
    yield* piStream(messages, systemPrompt, modelSpec, toolName, options);
  } else {
    yield* claudeStreamComplete(messages, systemPrompt, modelSpec, toolName);
  }
}

// --- Claude Resume (CC session operations) ---

export interface ClaudeResumeOptions {
  appendSystemPrompt?: string;
  model?: string;
  toolName?: string;
  stream?: boolean;
}

export async function claudeResume(sessionId: string, prompt: string, cwd: string, options: ClaudeResumeOptions = {}): Promise<string> {
  if (!hasClaude()) throw new Error("Claude Code not installed");

  const model = options.model || resolveModelSpec(null, options.toolName || null);
  const args = [
    "--resume", sessionId,
    "-p",
    "--bare",
    "--model", model,
    "--tools", "",
    "--no-session-persistence",
    "--fork-session",
  ];
  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  args.push(prompt);

  return new Promise((resolve, reject) => {
    const proc = nodeSpawn("claude", args, {
      cwd,
      stdio: ["pipe", "pipe", "pipe"],
      env: { ...process.env },
    });

    let stdout = "";
    let stderr = "";
    proc.stdout.on("data", (d: Buffer) => stdout += d);
    proc.stderr.on("data", (d: Buffer) => stderr += d);
    proc.on("error", reject);
    proc.on("close", (code: number) => {
      if (code !== 0) {
        reject(new Error(stderr || `claude exited with code ${code}`));
        return;
      }
      resolve(stdout);
    });
  });
}

export async function* claudeResumeStream(sessionId: string, prompt: string, cwd: string, options: ClaudeResumeOptions = {}): AsyncGenerator<{ type: string; delta: string }> {
  if (!hasClaude()) throw new Error("Claude Code not installed");

  const model = options.model || resolveModelSpec(null, options.toolName || null);
  const args = [
    "--resume", sessionId,
    "-p",
    "--bare",
    "--model", model,
    "--tools", "",
    "--no-session-persistence",
    "--fork-session",
    "--output-format", "stream-json",
    "--verbose",
  ];
  if (options.appendSystemPrompt) {
    args.push("--append-system-prompt", options.appendSystemPrompt);
  }
  args.push(prompt);

  const proc = nodeSpawn("claude", args, {
    cwd,
    stdio: ["pipe", "pipe", "pipe"],
    env: { ...process.env },
  });

  let buffer = "";

  for await (const data of proc.stdout) {
    buffer += data.toString();
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (!line.trim()) continue;
      try {
        const event = JSON.parse(line);
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
          yield { type: "text_delta", delta: event.delta.text };
        }
      } catch {}
    }
  }
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
