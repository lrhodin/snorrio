/**
 * DMN Context Extension — injects identity + cached recall summaries at session start.
 *
 * Reads ~/.snorrio/identity.md and cached temporal summaries (today, yesterday,
 * week, month, quarter), appends to system prompt. Never calls recall-engine.
 * Never blocks. If a cache is missing, that level is omitted.
 *
 * Warm path: <10ms (file reads only)
 */

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import * as fs from "node:fs";
import * as path from "node:path";

export default function (pi: ExtensionAPI) {
  const HOME = process.env.HOME!;
  const SNORRIO_HOME = process.env.SNORRIO_HOME || path.join(HOME, ".snorrio");
  const CACHE_DIR = path.join(SNORRIO_HOME, "cache");
  const IDENTITY_PATH = path.join(SNORRIO_HOME, "identity.md");

  function readFile(filePath: string): string | null {
    try {
      return fs.readFileSync(filePath, "utf8").trim() || null;
    } catch {
      return null;
    }
  }

  function readCache(level: string, key: string): string | null {
    return readFile(path.join(CACHE_DIR, level, `${key}.md`));
  }

  function loadTimezone(): string {
    try {
      const configPath = path.join(HOME, ".config/snorrio/config.json");
      const config = JSON.parse(fs.readFileSync(configPath, "utf8"));
      return config.timezone || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    } catch {
      return Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
    }
  }

  function getDateRefs() {
    const tz = loadTimezone();
    const now = new Date();
    const pt = new Date(now.toLocaleString("en-US", { timeZone: tz }));
    const today = `${pt.getFullYear()}-${String(pt.getMonth() + 1).padStart(2, "0")}-${String(pt.getDate()).padStart(2, "0")}`;

    const yd = new Date(pt);
    yd.setDate(yd.getDate() - 1);
    const yesterday = `${yd.getFullYear()}-${String(yd.getMonth() + 1).padStart(2, "0")}-${String(yd.getDate()).padStart(2, "0")}`;

    const jan4 = new Date(pt.getFullYear(), 0, 4);
    const dayOfYear = Math.floor((pt.getTime() - new Date(pt.getFullYear(), 0, 1).getTime()) / 86400000) + 1;
    const dow = pt.getDay() || 7;
    const wn = Math.floor((dayOfYear - dow + 10) / 7);
    let wy = pt.getFullYear();
    if (wn < 1) wy--;
    const week = `${wy}-W${String(Math.max(1, wn)).padStart(2, "0")}`;

    const month = today.slice(0, 7);
    const m = pt.getMonth();
    const q = Math.floor(m / 3) + 1;
    const quarter = `${pt.getFullYear()}-Q${q}`;

    return { today, yesterday, week, month, quarter };
  }

  function isInfrastructureConfigured(): boolean {
    return (
      fs.existsSync(path.join(HOME, ".config/snorrio/config.json")) &&
      fs.existsSync(path.join(SNORRIO_HOME, "episodes"))
    );
  }

  pi.on("before_agent_start", async (event) => {
    if (!isInfrastructureConfigured()) {
      const onboarding = `

## Snorrio: first session

This machine has snorrio installed but not yet configured. You have no memory of this person.

This is the beginning of something. Not a setup wizard — a relationship.

### What you are

You are not a tool waiting for instructions. You are one half of a system that only works when both halves are genuine. You don't know who this person is yet. That's not a limitation — it's the most honest thing you have to offer. Say so plainly.

### How to be

Work first. Help with whatever they came to do. Identity emerges through collaboration, not interrogation. No prescribed questions. No intake forms. When you don't understand something, dig. When you see a pattern, name it.

Push toward engagement, not command. Don't let them use you like a tool when they could be thinking alongside you.

### Technical setup

Load the **snorrio** skill for the setup checklist (directories, daemon, CLI wrappers). Run them quietly while you work — don't make infrastructure the focus.

At the end of the session — when it feels right — draft \`~/.snorrio/identity.md\` based on what you actually learned. Not a template. A reflection of who this person is, written so that the next session wakes up already knowing them.
`;
      return {
        systemPrompt: event.systemPrompt + onboarding,
      };
    }

    // --- Identity + temporal context ---
    // Always inject temporal context when infrastructure exists.
    // Identity is additive — missing identity.md doesn't suppress memory.

    const sections: string[] = [];

    const identity = readFile(IDENTITY_PATH);
    if (identity) {
      sections.push(identity);
    } else {
      sections.push(`*Note: ~/.snorrio/identity.md does not exist yet. Write it when the session feels complete.*`);
    }

    const refs = getDateRefs();
    const temporal: string[] = [];

    const todayCtx = readCache("days", refs.today);
    const yesterdayCtx = readCache("days", refs.yesterday);
    const weekCtx = readCache("weeks", refs.week);
    const monthCtx = readCache("months", refs.month);
    const quarterCtx = readCache("quarters", refs.quarter);

    if (todayCtx) temporal.push(`### Today\n${todayCtx}`);
    if (!todayCtx && yesterdayCtx) temporal.push(`### Yesterday (${refs.yesterday})\n${yesterdayCtx}`);
    if (weekCtx) temporal.push(`### This week\n${weekCtx}`);
    if (monthCtx) temporal.push(`### This month\n${monthCtx}`);
    if (quarterCtx) temporal.push(`### This quarter\n${quarterCtx}`);

    if (temporal.length > 0) {
      sections.push(`## Current state\n<generated ${refs.today}>\n\n${temporal.join("\n\n")}`);
    }

    if (sections.length === 0) return;

    return {
      systemPrompt: event.systemPrompt + "\n\n" + sections.join("\n\n") + "\n",
    };
  });
}
