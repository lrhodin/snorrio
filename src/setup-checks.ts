// Bounded, nonfatal setup diagnostics used by the Pi session-start extension.
// Expensive subprocesses belong here and run once per session, never once per
// agent turn.

import { existsSync, readFileSync, readdirSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { platform as osPlatform } from "node:os";

export interface ParsedToml {
  values: Map<string, string>;
}

export interface HerdrConfigInspection {
  resumeExplicitlyFalse: boolean;
  paneHistoryEnabled: boolean;
}

export interface SetupCheckResult {
  checkedAt: string;
  issues: string[];
  working: string[];
  notices: string[];
  message: string | null;
}

export type CommandRunner = (command: string, args: string[], timeout: number) => string | null;

export interface SetupCheckOptions {
  home: string;
  packageRoot: string;
  snorrioHome: string;
  env?: NodeJS.ProcessEnv;
  platform?: NodeJS.Platform;
  availableTools?: string[];
  commandRunner?: CommandRunner;
}

export interface SessionSetupCache {
  run(): SetupCheckResult;
  current(): SetupCheckResult | null;
}

export function parseSectionedToml(source: string): ParsedToml {
  const values = new Map<string, string>();
  let section = "";
  for (const rawLine of source.split("\n")) {
    const line = rawLine.replace(/\s+#.*$/, "").trim();
    if (!line || line.startsWith("#")) continue;
    const sectionMatch = line.match(/^\[([^\]]+)\]$/);
    if (sectionMatch) {
      section = sectionMatch[1].trim();
      continue;
    }
    const valueMatch = line.match(/^([A-Za-z0-9_-]+)\s*=\s*(.+)$/);
    if (!valueMatch) continue;
    values.set(section ? `${section}.${valueMatch[1]}` : valueMatch[1], valueMatch[2].trim());
  }
  return { values };
}

export function inspectHerdrConfig(source: string): HerdrConfigInspection {
  const parsed = parseSectionedToml(source);
  return {
    resumeExplicitlyFalse: parsed.values.get("session.resume_agents_on_restore") === "false",
    paneHistoryEnabled: parsed.values.get("experimental.pane_history") === "true",
  };
}

export function createSessionSetupCache(check: () => SetupCheckResult): SessionSetupCache {
  let result: SetupCheckResult | null = null;
  return {
    run() { return result = check(); },
    current() { return result; },
  };
}

export function defaultCommandRunner(command: string, args: string[], timeout = 5000): string | null {
  try {
    return execFileSync(command, args, { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout }).trim();
  } catch {
    return null;
  }
}

function hasEpisodeWithoutProvenance(episodesDir: string): boolean {
  try {
    for (const date of readdirSync(episodesDir).filter((name) => /^\d{4}-\d{2}-\d{2}$/.test(name)).sort()) {
      for (const file of readdirSync(join(episodesDir, date)).filter((name) => name.endsWith(".md"))) {
        const head = readFileSync(join(episodesDir, date, file), "utf8").slice(0, 4096);
        if (!/^lineage_metadata_version:\s*1\s*$/m.test(head) || !/^provenance_family_id:/m.test(head)) return true;
      }
    }
  } catch {}
  return false;
}

function hasCacheWithoutProvenance(cacheDir: string): boolean {
  for (const level of ["days", "weeks", "months", "quarters", "years"]) {
    try {
      for (const file of readdirSync(join(cacheDir, level)).filter((name) => name.endsWith(".md"))) {
        const ref = file.slice(0, -3);
        try {
          const parsed = JSON.parse(readFileSync(join(cacheDir, level, `${ref}.provenance.json`), "utf8"));
          if (parsed?.schemaVersion !== 1 || !Array.isArray(parsed?.families)) return true;
        } catch { return true; }
      }
    } catch {}
  }
  return false;
}

function parseBoolean(raw: string | undefined): boolean | null {
  if (raw === "true") return true;
  if (raw === "false") return false;
  return null;
}

export function isChildSession(env: NodeJS.ProcessEnv): boolean {
  return Boolean(env.PI_SUBAGENT_ID);
}

export function runSetupChecks(options: SetupCheckOptions): SetupCheckResult {
  const { home, packageRoot, snorrioHome } = options;
  const env = options.env ?? process.env;
  const platform = options.platform ?? osPlatform();
  const run: CommandRunner = options.commandRunner ?? defaultCommandRunner;
  const executable = (name: string) => run("which", [name], 1500) !== null;
  const issues: string[] = [];
  const working: string[] = [];
  const notices: string[] = [];
  const checkedAt = new Date().toISOString();
  const configPath = join(snorrioHome, "config", "config.json");
  const herdrConfigPath = join(home, ".config", "herdr", "config.toml");

  const legacyPaths: string[] = [];
  if (existsSync(join(home, ".snorrio"))) legacyPaths.push("~/.snorrio");
  if (existsSync(join(home, ".config", "snorrio", "config.json"))) legacyPaths.push("~/.config/snorrio/config.json");
  for (const path of ["episodes", "cache", "logs"]) {
    if (existsSync(join(packageRoot, path))) legacyPaths.push(`package:${path}`);
  }
  if (legacyPaths.length) issues.push(`legacy snorrio layout detected (${legacyPaths.join(", ")}) — migrate to the configured SNORRIO_HOME before continuing`);

  if (existsSync(configPath)) working.push("config exists");
  else issues.push(`missing config: create ${configPath}`);

  const dirs = ["episodes", "cache/days", "cache/weeks", "cache/months", "cache/quarters", "cache/years", "logs", "config"];
  const missingDirs = dirs.filter((dir) => !existsSync(join(snorrioHome, dir)));
  if (missingDirs.length === 0) working.push("data dirs exist");
  else issues.push(`missing data directories: ${missingDirs.join(", ")} (SETUP.md R2.1)`);
  const provenanceMarker = join(snorrioHome, "cache", "provenance-migration-v1.json");
  const markerExists = existsSync(provenanceMarker);
  // The first post-upgrade session scans until migration is recorded. Normal
  // sessions use the marker; daemon cache validation catches later drift.
  const episodeMigrationNeeded = !markerExists && hasEpisodeWithoutProvenance(join(snorrioHome, "episodes"));
  const cacheMigrationNeeded = !markerExists && hasCacheWithoutProvenance(join(snorrioHome, "cache"));
  if (episodeMigrationNeeded || cacheMigrationNeeded) {
    const missing = [episodeMigrationNeeded ? "episode metadata" : "", cacheMigrationNeeded ? "cache manifests" : ""].filter(Boolean).join(" and ");
    issues.push(`legacy provenance migration required (${missing}) — run \`snorrio migrate-provenance --dry-run\`, then \`snorrio migrate-provenance\` before treating temporal caches as authoritative`);
  } else if (markerExists) {
    working.push("provenance migration v1 recorded");
  }

  const missingClis = ["recall", "snorrio", "llm"].filter((cli) => !executable(cli));
  if (missingClis.length === 0) working.push("CLIs on PATH");
  else issues.push(`CLIs not on PATH: ${missingClis.join(", ")} — see SETUP.md R3.1`);

  let daemonPid: string | null = null;
  if (platform === "darwin") {
    const output = run("launchctl", ["list", "io.snorrio.dmn"], 3000);
    daemonPid = output?.match(/"PID"\s*=\s*(\d+)/)?.[1] ?? output?.match(/^(\d+)\s/m)?.[1] ?? null;
  } else {
    const active = run("systemctl", ["--user", "is-active", "io.snorrio.dmn.service"], 3000);
    if (active === "active") {
      const pid = run("systemctl", ["--user", "show", "-p", "MainPID", "--value", "io.snorrio.dmn.service"], 3000);
      if (pid && pid !== "0") daemonPid = pid;
    }
  }
  if (daemonPid) working.push(`daemon live (PID ${daemonPid})`);
  else issues.push("memory daemon is not live — no episodes will form until it is (SETUP.md R4.1)");
  if (platform === "darwin") {
    const uid = run("id", ["-u"], 1500);
    const supervised = uid ? run("launchctl", ["print", `gui/${uid}/io.snorrio.dmn`], 3000) : null;
    if (supervised) working.push("daemon launchd supervisor registered");
    else issues.push("memory daemon liveness does not prove supervision — launchd job io.snorrio.dmn is not registered");
  } else {
    const enabled = run("systemctl", ["--user", "is-enabled", "io.snorrio.dmn.service"], 3000);
    if (enabled === "enabled") working.push("daemon systemd supervisor enabled");
    else issues.push("memory daemon service is not enabled for supervised restart");
  }

  let packageSources: string[] = [];
  try {
    const settings = JSON.parse(readFileSync(join(home, ".pi", "agent", "settings.json"), "utf8"));
    packageSources = (settings.packages ?? []).map((entry: any) => typeof entry === "string" ? entry : entry?.source ?? "");
    if (packageSources.some((source) => source.includes("snorrio"))) working.push("snorrio Pi package installed");
    else issues.push("snorrio not installed as a Pi package — run `pi install https://github.com/lrhodin/snorrio`");
    if (packageSources.some((source) => source.includes("pi-herdr-subagents"))) working.push("pi-herdr-subagents installed");
    else issues.push("required Pi package missing: pi-herdr-subagents (SETUP.md R5.7)");
    if (packageSources.some((source) => source.includes("pi-herdr-agents"))) {
      issues.push("pi-herdr-agents is installed and collides with pi-herdr-subagents; remove pi-herdr-agents (SETUP.md R5.7)");
    }
  } catch {
    issues.push("cannot read Pi settings");
  }

  const herdrPresent = executable("herdr");
  if (!herdrPresent) {
    issues.push("herdr is not on PATH (SETUP.md R5.1)");
  } else {
    const statusText = run("herdr", ["status", "server", "--json"], 5000);
    let status: any = null;
    try { status = statusText ? JSON.parse(statusText) : null; } catch {}
    if (status?.running === true && status?.compatible !== false && status?.restart_needed !== true) {
      working.push(`herdr server live${status.version ? ` (${status.version})` : ""}`);
    } else if (status?.running === true) {
      issues.push("herdr server answers but client/server integration is not current; update or restart through the supervisor");
    } else {
      issues.push("herdr server is not answering (SETUP.md R5.2)");
    }

    if (platform === "darwin") {
      const brewService = run("brew", ["services", "info", "herdr", "--json"], 5000);
      let service: any = null;
      try { service = brewService ? JSON.parse(brewService)?.[0] : null; } catch {}
      if (service?.running === true) {
        working.push("herdr Homebrew service running");
        const currentUser = run("id", ["-un"], 1500);
        if (service.user && currentUser && service.user !== currentUser) issues.push(`herdr Homebrew service is owned by ${service.user}, expected ${currentUser}`);
      } else if (service) {
        issues.push("herdr Homebrew service exists but is not running — adopt/restart it through brew services (SETUP.md R5.1)");
      } else {
        issues.push("cannot validate Herdr Homebrew supervision (missing or malformed `brew services info herdr --json` output)");
      }
    } else {
      const enabled = ["herdr.service", "herdr-server.service"].some((name) =>
        run("systemctl", ["--user", "is-enabled", name], 3000) === "enabled"
      );
      if (enabled) working.push("herdr user service enabled");
      else issues.push("herdr server lacks a detected enabled user service — configure supervised restart (SETUP.md R5.1)");
    }

    const integration = run("herdr", ["integration", "status"], 5000);
    if (integration && /^pi:\s+current\b/m.test(integration)) working.push("herdr Pi integration current");
    else issues.push("herdr Pi integration is missing or outdated — run `herdr integration install pi`");

    const configCheck = run("herdr", ["config", "check"], 5000);
    if (configCheck && /config:\s*ok/i.test(configCheck)) working.push("herdr config valid");
    else issues.push("herdr config is invalid — run `herdr config check` and fix its diagnostics");

    if (existsSync(herdrConfigPath)) {
      try {
        const source = readFileSync(herdrConfigPath, "utf8");
        const parsed = parseSectionedToml(source);
        const inspection = inspectHerdrConfig(source);
        const resume = parseBoolean(parsed.values.get("session.resume_agents_on_restore"));
        if (inspection.resumeExplicitlyFalse) issues.push("[session].resume_agents_on_restore is explicitly false; native agent resume defaults true and must not be disabled");
        else working.push(`native agent resume ${resume === true ? "enabled" : "using the true default"}`);

        if (inspection.paneHistoryEnabled) {
          notices.push("[experimental].pane_history is enabled: pane terminal contents, including visible secrets, persist in session-history.json. It is optional and is not required for Pi resume.");
        }
      } catch {
        issues.push(`cannot read ${herdrConfigPath}`);
      }
    } else {
      working.push("herdr config defaults active (native resume true; toasts off; pane history off)");
    }
  }

  const runtimeVars = ["HERDR_PANE_ID", "HERDR_TAB_ID", "HERDR_WORKSPACE_ID", "HERDR_SOCKET_PATH"];
  const missingRuntime = runtimeVars.filter((name) => !env[name]);
  if (env.HERDR_ENV === "1" && missingRuntime.length === 0) {
    working.push(`Pi inside Herdr (${env.HERDR_WORKSPACE_ID}/${env.HERDR_TAB_ID}/${env.HERDR_PANE_ID}, socket ${env.HERDR_SOCKET_PATH})`);
  } else {
    issues.push(`Pi is not running inside a Herdr pane — require HERDR_ENV=1 plus ${runtimeVars.join(", ")}. Exit, attach with \`herdr\`, and start Pi in that pane; do not nest Herdr.`);
  }

  const agentDir = join(home, ".pi", "agent", "agents");
  let definitions: string[] = [];
  try { definitions = readdirSync(agentDir).filter((file) => file.endsWith(".md")); } catch {}
  if (definitions.includes("recall-digger.md")) working.push("subagent definition recall-digger available");
  else issues.push("recall-digger subagent definition is not discoverable under ~/.pi/agent/agents (SETUP.md R5.8)");

  if (!isChildSession(env)) {
    const available = new Set(options.availableTools ?? []);
    const requiredTools = ["subagent", "subagent_interrupt", "subagent_resume", "subagents_list"];
    const missingTools = requiredTools.filter((tool) => !available.has(tool));
    if (missingTools.length === 0) working.push("subagent lifecycle tools available");
    else issues.push(`subagent lifecycle tools unavailable: ${missingTools.join(", ")} — verify pi-herdr-subagents in a fresh Pi session`);
  } else {
    working.push("child session detected; spawning-tool availability intentionally not required");
  }

  let message: string | null = null;
  if (issues.length || notices.length) {
    const title = issues.length
      ? `[snorrio setup incomplete — ${issues.length} issue${issues.length === 1 ? "" : "s"}; checked ${checkedAt}]`
      : `[snorrio setup notice; checked ${checkedAt}]`;
    const blocks = [title];
    if (issues.length) blocks.push(issues.map((issue, index) => `${index + 1}. ${issue}`).join("\n"));
    if (notices.length) blocks.push(`Notices:\n${notices.map((notice) => `- ${notice}`).join("\n")}`);
    if (working.length) blocks.push(`Working: ${working.join(", ")}`);
    blocks.push("SETUP.md in the snorrio package is addressed to the agent and contains the repair procedure.");
    message = blocks.join("\n\n");
  }

  return { checkedAt, issues, working, notices, message };
}
