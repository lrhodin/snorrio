// Pi extension — injects snorrio context and setup detection at session start.
// All temporal logic lives in src/context.ts. This is the pi glue.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";
import { platform } from "node:os";

const HOME = process.env.HOME!;
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNORRIO_HOME = process.env.SNORRIO_HOME || join(HOME, "snorrio");
const CONFIG_PATH = join(SNORRIO_HOME, "config", "config.json");
const HERDR_CONFIG = join(HOME, ".config", "herdr", "config.toml");
const HERDR_PI_HOOK = join(HOME, ".pi", "agent", "extensions", "herdr-agent-state.ts");

// Harness packages that must be present in pi settings. Keyed by the tools they
// provide, so the diagnostic can say what's missing rather than just a name.
const HARNESS_PACKAGES: Array<{ id: string; provides: string }> = [
  { id: "@ogulcancelik/pi-herdr", provides: "herdr_layout / herdr_pane / herdr_agent" },
  { id: "pi-herdr-subagents", provides: "subagent / subagent_resume / subagents_list" },
];

// ── Setup detection ──
// Checks what's working and what isn't. Returns null if everything's fine,
// or a diagnostic message for the agent if setup is incomplete.
//
// This runs at every session start, which is deliberate: setup lives in prose
// (SETUP.md) rather than an installer, so this is the thing that makes prose
// safe. An installer verifies once; this verifies every session, and catches
// drift an installer never would (node upgraded, server died, config reset).
function checkSetup(): string | null {
  const issues: string[] = [];
  const ok: string[] = [];

  const legacyPaths: string[] = [];
  if (existsSync(join(HOME, ".snorrio"))) legacyPaths.push("~/.snorrio");
  if (existsSync(join(HOME, ".config", "snorrio", "config.json"))) legacyPaths.push("~/.config/snorrio/config.json");
  for (const path of ["episodes", "cache", "logs"]) {
    if (existsSync(join(PKG_ROOT, path))) legacyPaths.push(`package:${path}`);
  }
  if (legacyPaths.length > 0) {
    issues.push(`legacy snorrio layout detected (${legacyPaths.join(", ")}) — migrate to ~/snorrio before continuing`);
  }

  // 1. Config
  if (existsSync(CONFIG_PATH)) ok.push("config exists");
  else issues.push("missing config: create ~/snorrio/config/config.json");

  // 2. Data directories
  const dirs = ["episodes", "cache/days", "cache/weeks", "cache/months", "cache/quarters", "cache/years", "logs", "config"];
  const missingDirs = dirs.filter(d => !existsSync(join(SNORRIO_HOME, d)));
  if (missingDirs.length === 0) ok.push("data dirs exist");
  else issues.push(`missing directories: run \`mkdir -p ~/snorrio/{${missingDirs.join(",")}}\``);

  // 3. CLI tools
  const clis = ["recall", "snorrio", "llm"];
  const missingClis: string[] = [];
  for (const cli of clis) {
    try { execSync(`which ${cli}`, { stdio: "pipe" }); }
    catch { missingClis.push(cli); }
  }
  if (missingClis.length === 0) ok.push("CLIs on PATH");
  else issues.push(`CLIs not on PATH: ${missingClis.join(", ")} — see SETUP.md R3.1, and check ~/.local/bin is in PATH`);

  // 4. Daemon
  let daemonRunning = false;
  try {
    if (platform() === "darwin") {
      const out = execSync("launchctl list io.snorrio.dmn 2>/dev/null", { encoding: "utf8", stdio: "pipe" });
      daemonRunning = out.includes("PID") || /^\d+/m.test(out);
    } else {
      const out = execSync("systemctl --user is-active io.snorrio.dmn.service 2>/dev/null", { encoding: "utf8", stdio: "pipe" });
      daemonRunning = out.trim() === "active";
    }
  } catch {}
  if (daemonRunning) ok.push("daemon running");
  else issues.push("memory daemon not running — no episodes will form until it is (SETUP.md R4.1)");

  // 5. Packages installed — snorrio itself, plus the herdr harness. The harness
  //    is not optional: memory answers what happened before, the harness is how
  //    work happens now, and half a system is worse than either half alone.
  try {
    const settings = JSON.parse(readFileSync(join(HOME, ".pi/agent/settings.json"), "utf8"));
    const packages: any[] = settings.packages || [];
    const sources = packages.map((p: any) => (typeof p === "string" ? p : p?.source) || "");

    if (sources.some(s => s.includes("snorrio"))) ok.push("package installed");
    else issues.push("snorrio not installed as pi package — run `pi install https://github.com/lrhodin/snorrio`");

    const missingPkgs = HARNESS_PACKAGES.filter(p => !sources.some(s => s.includes(p.id)));
    if (missingPkgs.length === 0) ok.push("harness packages installed");
    else {
      for (const p of missingPkgs) {
        issues.push(`harness package missing: ${p.id} — provides ${p.provides} (SETUP.md R5.7)`);
      }
    }

    // Wrong-package trap: same extension path, same tool name, different author.
    if (sources.some(s => s.includes("pi-herdr-agents"))) {
      issues.push("`pi-herdr-agents` is installed — it collides with `pi-herdr-subagents` (same extension path, same `subagent` tool). Remove one (SETUP.md R5.7)");
    }
  } catch {
    issues.push("can't read pi settings");
  }

  // 6. Harness — binary, live server, resume hook.
  let herdrPresent = false;
  try { execSync("which herdr", { stdio: "pipe" }); herdrPresent = true; }
  catch { issues.push("herdr not on PATH — the harness ships with snorrio (SETUP.md R5.1)"); }

  if (herdrPresent) {
    // `herdr status server` talks to the socket, so this distinguishes a server
    // that answers from a unit that merely claims to be loaded.
    let serverRunning = false;
    try {
      const out = execSync("herdr status server 2>/dev/null", { encoding: "utf8", stdio: "pipe", timeout: 5000 });
      serverRunning = /status:\s*running/.test(out);
    } catch {}
    if (serverRunning) ok.push("herdr server running");
    else issues.push("herdr server not answering — check for stale sockets in ~/.config/herdr/ before restarting (SETUP.md R5.2)");

    if (existsSync(HERDR_PI_HOOK)) ok.push("herdr pi hook installed");
    else issues.push("herdr pi integration hook missing — run `herdr integration install pi` (SETUP.md R5.4)");

    // Resume config. Absent file is itself the finding; don't parse TOML for one key.
    try {
      const toml = readFileSync(HERDR_CONFIG, "utf8");
      if (/^\s*resume_agents_on_restore\s*=\s*true/m.test(toml)) ok.push("agent resume enabled");
      else issues.push("agent resume not enabled — set `[session] resume_agents_on_restore = true` in ~/.config/herdr/config.toml (SETUP.md R5.5)");
    } catch {
      issues.push("no ~/.config/herdr/config.toml — agent resume and toast delivery are unset (SETUP.md R5.5, R5.6)");
    }
  }

  // 7. Has any episodes?
  const episodesDir = join(SNORRIO_HOME, "episodes");
  let hasEpisodes = false;
  try {
    const days = readdirSync(episodesDir).filter(d => /^\d{4}-\d{2}-\d{2}$/.test(d));
    hasEpisodes = days.length > 0;
  } catch {}

  if (issues.length === 0) return null;

  let msg = `[snorrio setup incomplete — ${issues.length} issue${issues.length > 1 ? "s" : ""}]\n\n`;
  msg += issues.map((i, n) => `${n + 1}. ${i}`).join("\n");
  if (ok.length > 0) msg += `\n\nWorking: ${ok.join(", ")}`;
  if (!hasEpisodes) msg += `\n\nNote: no episodes yet. This is normal on first install — episodes are generated after your first session ends.`;
  msg += `\n\nSETUP.md in the snorrio package is addressed to you and states each requirement with its reasoning. Read it before fixing any of the above.`;

  return msg;
}

function getTimezone(): string {
  try {
    const cfg = JSON.parse(readFileSync(CONFIG_PATH, "utf8"));
    return cfg.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  } catch {
    return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }
}

function formatStamp(ts: number, tz: string): string {
  return new Date(ts).toLocaleString("en-US", {
    timeZone: tz,
    weekday: "short",
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    hour12: true,
    timeZoneName: "short",
  });
}

function formatGap(ms: number): string {
  const mins = Math.round(ms / 60000);
  if (mins < 60) return `${mins} minutes`;
  const hrs = Math.floor(mins / 60);
  const rem = mins % 60;
  if (hrs < 24) return rem > 0 ? `${hrs}h ${rem}m` : `${hrs} hour${hrs > 1 ? "s" : ""}`;
  const days = Math.floor(hrs / 24);
  const remHrs = hrs % 24;
  return remHrs > 0 ? `${days}d ${remHrs}h` : `${days} day${days > 1 ? "s" : ""}`;
}

export const GAP_MS = 4.5 * 60 * 1000; // 4:30, aligned with DMN idle timer

// Pure transform: mutates `messages` in place, prefixing user/assistant
// messages with timestamps and silence markers per the rules described on
// the `context` handler below. Exported for testing.
export function applyStamps(messages: any[], tz: string, gapThresholdMs: number = GAP_MS): void {
  const userIndices: number[] = [];
  for (let i = 0; i < messages.length; i++) {
    if (messages[i].role === "user" && messages[i].timestamp) {
      userIndices.push(i);
    }
  }
  if (userIndices.length === 0) return;

  const stampSet = new Set<number>();
  const gapBefore = new Map<number, number>();

  stampSet.add(userIndices[0]);
  stampSet.add(userIndices[userIndices.length - 1]);

  for (let j = 1; j < userIndices.length; j++) {
    const prevTs = messages[userIndices[j - 1]].timestamp;
    const currTs = messages[userIndices[j]].timestamp;
    const delta = currTs - prevTs;
    if (delta >= gapThresholdMs) {
      stampSet.add(userIndices[j - 1]);
      stampSet.add(userIndices[j]);
      gapBefore.set(userIndices[j], delta);
    }
  }

  for (const idx of stampSet) {
    const msg = messages[idx];
    if (msg.role !== "user" && msg.role !== "assistant") continue;
    const stamp = formatStamp(msg.timestamp, tz);
    const gap = gapBefore.get(idx);
    const prefix = gap
      ? `[${formatGap(gap)} of silence]\n[${stamp}] `
      : `[${stamp}] `;

    const content = msg.content;
    if (Array.isArray(content)) {
      const first = content.find(
        (b: any): b is { type: "text"; text: string } =>
          (b as { type?: string }).type === "text",
      );
      if (first) first.text = prefix + first.text;
    } else if (typeof content === "string") {
      msg.content = prefix + content;
    }
  }
}

export default function (pi: ExtensionAPI) {
  const tz = getTimezone();

  pi.on("before_agent_start", async (event) => {
    const { loadContext, getDateRefs } = await import(join(PKG_ROOT, "src", "context.ts"));

    let prompt = event.systemPrompt;

    // Fix pi's UTC date with timezone-aware local date
    const { today } = getDateRefs();
    prompt = prompt.replace(/Current date: \d{4}-\d{2}-\d{2}/, `Current date: ${today}`);

    // Setup detection — nudge the agent if things aren't configured
    const setupMsg = checkSetup();
    if (setupMsg) prompt += "\n\n" + setupMsg + "\n";

    // Temporal context injection
    const ctx = loadContext();
    if (ctx) prompt += "\n\n" + ctx + "\n";

    return { systemPrompt: prompt };
  });

  // Stamp user messages with local time:
  // - Always stamp first and last user messages
  // - On gaps >= 4:30: stamp both sides and insert a silence marker
  pi.on("context", (event) => {
    applyStamps(event.messages as any[], tz, GAP_MS);
    return { messages: event.messages };
  });
}
