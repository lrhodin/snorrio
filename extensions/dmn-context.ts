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

  let injected = false;

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

  pi.on("before_agent_start", async (event) => {
    if (injected) return;
    injected = true;

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
