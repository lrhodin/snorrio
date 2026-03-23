#!/usr/bin/env node
// SessionStart hook for Claude Code.
// Reads identity + cached temporal summaries and prints to stdout.
// Claude Code injects stdout into the conversation as context.

import { readFileSync } from "fs";
import { join } from "path";

const HOME = process.env.HOME;
const SNORRIO_HOME = process.env.SNORRIO_HOME || join(HOME, ".snorrio");
const CACHE_DIR = join(SNORRIO_HOME, "cache");
const IDENTITY_PATH = join(SNORRIO_HOME, "identity.md");

function readFile(path) {
  try { return readFileSync(path, "utf8").trim() || null; }
  catch { return null; }
}

function readCache(level, key) {
  return readFile(join(CACHE_DIR, level, `${key}.md`));
}

function loadTimezone() {
  try {
    const config = JSON.parse(readFileSync(join(HOME, ".config/snorrio/config.json"), "utf8"));
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

  const dayOfYear = Math.floor((pt.getTime() - new Date(pt.getFullYear(), 0, 1).getTime()) / 86400000) + 1;
  const dow = pt.getDay() || 7;
  const wn = Math.floor((dayOfYear - dow + 10) / 7);
  let wy = pt.getFullYear();
  if (wn < 1) wy--;
  const week = `${wy}-W${String(Math.max(1, wn)).padStart(2, "0")}`;

  const month = today.slice(0, 7);
  const q = Math.floor(pt.getMonth() / 3) + 1;
  const quarter = `${pt.getFullYear()}-Q${q}`;

  return { today, yesterday, week, month, quarter };
}

// --- Main ---

const output = [];

// Identity
const identity = readFile(IDENTITY_PATH);
if (identity) output.push(identity);

// Temporal context
const refs = getDateRefs();
const sections = [];

const todayCtx = readCache("days", refs.today);
const yesterdayCtx = readCache("days", refs.yesterday);
const weekCtx = readCache("weeks", refs.week);
const monthCtx = readCache("months", refs.month);
const quarterCtx = readCache("quarters", refs.quarter);

if (todayCtx) sections.push(`### Today\n${todayCtx}`);
if (!todayCtx && yesterdayCtx) sections.push(`### Yesterday (${refs.yesterday})\n${yesterdayCtx}`);
if (weekCtx) sections.push(`### This week\n${weekCtx}`);
if (monthCtx) sections.push(`### This month\n${monthCtx}`);
if (quarterCtx) sections.push(`### This quarter\n${quarterCtx}`);

if (sections.length > 0) {
  output.push(`## Current state\n<generated ${refs.today}>\n\n${sections.join("\n\n")}`);
}

if (output.length === 0) {
  process.exit(0);
}

console.log(output.join("\n\n"));
