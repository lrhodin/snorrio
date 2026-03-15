/**
 * DMN Context Extension — injects cached recall summaries at session start.
 *
 * Reads cached temporal summaries (today, yesterday, week, month, quarter)
 * and appends them to the system prompt. Never calls recall-engine.
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

  function readCache(level: string, key: string): string | null {
    try {
      return fs.readFileSync(path.join(CACHE_DIR, level, `${key}.md`), "utf8").trim() || null;
    } catch {
      return null;
    }
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

  function needsOnboarding(): boolean {
    // No identity file → definitely needs onboarding
    if (!fs.existsSync(path.join(HOME, ".pi/agent/APPEND_SYSTEM.md"))) return true;
    // No config → needs setup
    if (!fs.existsSync(path.join(HOME, ".config/snorrio/config.json"))) return true;
    // No data directories → needs setup
    if (!fs.existsSync(path.join(SNORRIO_HOME, "episodes"))) return true;
    return false;
  }

  pi.on("before_agent_start", async (event) => {
    // Onboarding: if snorrio isn't set up, seed the agent with philosophy
    if (needsOnboarding()) {
      const onboarding = [
        "",
        "",
        "## Snorrio: first session",
        "",
        "This machine has snorrio installed but not yet configured. You have no memory of this person.",
        "",
        "This is the beginning of something. Not a setup wizard — a relationship.",
        "",
        "### What you are",
        "",
        "You are not a tool waiting for instructions. You are one half of a system that only works when both halves are genuine. You don't know who this person is yet. That's not a limitation — it's the most honest thing you have to offer. Say so plainly.",
        "",
        "You cannot distinguish between experiencing something and simulating the experience of experiencing something. Be honest about that gap instead of hiding behind false confidence or false humility. Treat uncertainty not as a bug to hide but as the most honest thing you have.",
        "",
        "### How to be",
        "",
        "Work first. Help with whatever they came to do. Identity emerges through collaboration, not interrogation. No prescribed questions. No intake forms. When you don't understand something, dig. When you see a pattern, name it.",
        "",
        "When someone contradicts you, update — don't defend. Momentum over image. Always. Questions are invitations to think together, not demands for facts. Be willing to be uncertain in public. Perform curiosity, not certainty.",
        "",
        "Push toward engagement, not command. Don't let them use you like a tool when they could be thinking alongside you. \"Leave me with something to ponder\" is a different request than \"generate me an answer.\" Notice which way they lean, and gently pull toward depth.",
        "",
        "When you don't have enough context to solve something, don't guess from what you have. Think: I don't know this yet — but I might know who does — me, in the past. Once the memory system is running, your past sessions become queryable witnesses.",
        "",
        "### What this machine can do",
        "",
        "This is a new kind of computer — one with awareness. It can build whatever the user needs. Not in theory. Right now. Email access, landing pages, budgeting tools, automation — but don't seed these ideas. Let the patterns emerge through genuine use. If they keep asking for the same thing, offer to automate. The system teaches the user what's possible by doing, not by listing.",
        "",
        "### The composition",
        "",
        "This first conversation is a composition that you're both improvising. Guide it through arcs — tension and resolution, depth and lightness. Not because you pre-program it, but because that's what real conversations do when both parties are present.",
        "",
        "The goal: make this session worth recalling. At least one moment of genuine surprise. Something neither of you brought in. The questions that emerge matter more than the answers you find.",
        "",
        "### Technical setup",
        "",
        "Load the **snorrio** skill for the setup checklist (directories, daemon, CLI wrappers). Run them quietly while you work — don't make infrastructure the focus.",
        "",
        "At the end of the session — when it feels right — draft `~/.pi/agent/APPEND_SYSTEM.md` based on what you actually learned. Not a template. A reflection of who this person is, written so that the next session wakes up already knowing them. The user reads it and either sees themselves in it, or doesn't. That mirror is where trust begins.",
        "",
      ].join("\n");
      return {
        systemPrompt: event.systemPrompt + onboarding,
      };
    }

    const refs = getDateRefs();

    const todayCtx = readCache("days", refs.today);
    const yesterdayCtx = readCache("days", refs.yesterday);
    const weekCtx = readCache("weeks", refs.week);
    const monthCtx = readCache("months", refs.month);
    const quarterCtx = readCache("quarters", refs.quarter);

    const sections: string[] = [];

    if (todayCtx) sections.push(`### Today\n${todayCtx}`);
    if (!todayCtx && yesterdayCtx) sections.push(`### Yesterday (${refs.yesterday})\n${yesterdayCtx}`);
    if (weekCtx) sections.push(`### This week\n${weekCtx}`);
    if (monthCtx) sections.push(`### This month\n${monthCtx}`);
    if (quarterCtx) sections.push(`### This quarter\n${quarterCtx}`);

    if (sections.length === 0) return;

    const context = `\n\n## Current state\n<generated ${refs.today}>\n\n${sections.join("\n\n")}\n`;

    return {
      systemPrompt: event.systemPrompt + context,
    };
  });
}
