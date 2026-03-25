// Pi extension — injects snorrio context and setup detection at session start.
// All temporal logic lives in src/context.ts. This is the pi glue.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";
import { readFileSync, existsSync, readdirSync } from "node:fs";
import { execSync } from "node:child_process";

const HOME = process.env.HOME!;
const SNORRIO_HOME = process.env.SNORRIO_HOME || join(HOME, "snorrio");

// ── Setup detection ──
// Checks what's working and what isn't. Returns null if everything's fine,
// or a diagnostic message for the agent if setup is incomplete.
function checkSetup(): string | null {
  const issues: string[] = [];
  const ok: string[] = [];

  // 1. Config
  const configPath = join(HOME, ".config/snorrio/config.json");
  if (existsSync(configPath)) ok.push("config exists");
  else issues.push("missing config: run `mkdir -p ~/.config/snorrio && echo '{\"model\":\"opus\",\"timezone\":null,\"tools\":{}}' > ~/.config/snorrio/config.json`");

  // 2. Data directories
  const dirs = ["episodes", "cache/days", "cache/weeks", "cache/months", "cache/quarters", "logs"];
  const missingDirs = dirs.filter(d => !existsSync(join(SNORRIO_HOME, d)));
  if (missingDirs.length === 0) ok.push("data dirs exist");
  else issues.push(`missing directories: run \`mkdir -p ~/snorrio/{${missingDirs.join(",")}}\``);

  // 3. CLI tools
  const clis = ["recall", "snorrio", "subagent"];
  const missingClis: string[] = [];
  for (const cli of clis) {
    try { execSync(`which ${cli}`, { stdio: "pipe" }); }
    catch { missingClis.push(cli); }
  }
  if (missingClis.length === 0) ok.push("CLIs on PATH");
  else issues.push(`CLIs not on PATH: ${missingClis.join(", ")} — run the install script or check ~/.local/bin is in PATH`);

  // 4. Daemon
  let daemonRunning = false;
  try {
    const out = execSync("launchctl list io.snorrio.dmn 2>/dev/null", { encoding: "utf8", stdio: "pipe" });
    daemonRunning = out.includes("PID") || /^\d+/m.test(out);
  } catch {}
  if (daemonRunning) ok.push("daemon running");
  else issues.push("daemon not running — load the snorrio skill for setup instructions");

  // 5. Skills registered
  try {
    const settings = JSON.parse(readFileSync(join(HOME, ".pi/agent/settings.json"), "utf8"));
    const skills: string[] = settings.skills || [];
    if (skills.some((s: string) => s.includes("snorrio/skills"))) ok.push("skills registered");
    else issues.push("snorrio skills not in pi settings — add `~/snorrio/skills` to the skills array in ~/.pi/agent/settings.json");
  } catch {
    issues.push("can't read pi settings");
  }

  // 6. Has any episodes?
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
  msg += `\n\nLoad the snorrio skill for full setup instructions.`;

  return msg;
}

function getTimezone(): string {
  try {
    const cfg = JSON.parse(readFileSync(join(HOME, ".config/snorrio/config.json"), "utf8"));
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

const GAP_MS = 4.5 * 60 * 1000; // 4:30, aligned with DMN idle timer

export default function (pi: ExtensionAPI) {
  const tz = getTimezone();

  pi.on("before_agent_start", async (event) => {
    const { loadContext, getDateRefs } = await import(join(SNORRIO_HOME, "src", "context.ts"));

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
    const userIndices: number[] = [];
    for (let i = 0; i < event.messages.length; i++) {
      if (event.messages[i].role === "user" && event.messages[i].timestamp) {
        userIndices.push(i);
      }
    }
    if (userIndices.length === 0) return { messages: event.messages };

    // Determine which messages to stamp and where gaps are
    const stampSet = new Set<number>();
    const gapBefore = new Map<number, number>(); // index -> gap duration in ms

    // Always stamp first and last
    stampSet.add(userIndices[0]);
    stampSet.add(userIndices[userIndices.length - 1]);

    // Find gaps — stamp both edges and record the gap
    for (let j = 1; j < userIndices.length; j++) {
      const prevTs = event.messages[userIndices[j - 1]].timestamp;
      const currTs = event.messages[userIndices[j]].timestamp;
      const delta = currTs - prevTs;
      if (delta >= GAP_MS) {
        stampSet.add(userIndices[j - 1]); // before gap
        stampSet.add(userIndices[j]);     // after gap
        gapBefore.set(userIndices[j], delta);
      }
    }

    // Apply stamps and gap markers
    for (const idx of stampSet) {
      const msg = event.messages[idx];
      const stamp = formatStamp(msg.timestamp, tz);
      const gap = gapBefore.get(idx);
      const prefix = gap
        ? `[${formatGap(gap)} of silence]\n[${stamp}] `
        : `[${stamp}] `;

      const content = msg.content;
      if (Array.isArray(content)) {
        const first = content.find((b: any) => b.type === "text");
        if (first) first.text = prefix + first.text;
      } else if (typeof content === "string") {
        msg.content = prefix + content;
      }
    }

    return { messages: event.messages };
  });
}
