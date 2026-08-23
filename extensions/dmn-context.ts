// Pi extension — checks setup at session start; refreshes temporal context each turn.
// All temporal logic lives in src/context.ts. This is the pi glue.

import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { createSessionSetupCache, runSetupChecks } from "../src/setup-checks.ts";

const HOME = process.env.HOME!;
const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");
const SNORRIO_HOME = process.env.SNORRIO_HOME || join(HOME, "snorrio");
const CONFIG_PATH = join(SNORRIO_HOME, "config", "config.json");

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

export function composeInjectedPrompt(base: string, today: string, setupMessage: string | null, temporalContext: string | null): string {
  let prompt = base.replace(/Current date: \d{4}-\d{2}-\d{2}/, `Current date: ${today}`);
  if (setupMessage) prompt += "\n\n" + setupMessage + "\n";
  if (temporalContext) prompt += "\n\n" + temporalContext + "\n";
  return prompt;
}

export default function (pi: ExtensionAPI) {
  const tz = getTimezone();
  const setup = createSessionSetupCache(() => runSetupChecks({
    home: HOME,
    packageRoot: PKG_ROOT,
    snorrioHome: SNORRIO_HOME,
    env: process.env,
    availableTools: pi.getAllTools().map((tool: any) => tool.name).filter(Boolean),
  }));

  // Only subprocess-heavy setup checks are cached. Date refs and temporal
  // caches are cheap local reads and refresh for every turn so a long-lived
  // Herdr pane crosses midnight and observes newly generated cache files.
  pi.on("session_start", () => { setup.run(); });

  pi.on("before_agent_start", async (event) => {
    const { loadContext, getDateRefs } = await import(join(PKG_ROOT, "src", "context.ts"));
    return {
      systemPrompt: composeInjectedPrompt(
        event.systemPrompt,
        getDateRefs().today,
        setup.current()?.message ?? null,
        loadContext(),
      ),
    };
  });

  // Stamp user messages with local time:
  // - Always stamp first and last user messages
  // - On gaps >= 4:30: stamp both sides and insert a silence marker
  pi.on("context", (event) => {
    applyStamps(event.messages as any[], tz, GAP_MS);
    return { messages: event.messages };
  });
}
