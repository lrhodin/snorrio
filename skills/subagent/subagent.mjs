#!/usr/bin/env node

import { execSync, spawn } from "child_process";
import { mkdtempSync, cpSync, symlinkSync, readdirSync, rmSync, existsSync, statSync, readFileSync, mkdirSync } from "fs";
import { join, resolve, basename } from "path";
import { homedir, tmpdir } from "os";

const PI_DIR = join(homedir(), ".pi", "agent");

function usage() {
  console.log(`Usage: subagent <command> [args]

Commands:
  spawn <workspace-dir> <name> [name...]           Spawn agents from prompts/<name>.md in workspace
  spawn <session-name> <prompt-file> [-c <dir>]    Spawn a single agent
  wait <workspace-dir>                             Wait for all agents in workspace
  wait <prefix>                                    Wait for all agents matching prefix
  wait <session-name> [session-name...]            Wait for named agents
  status [workspace-dir]                           Show agent status (all or workspace)
  list [prefix]                                    List active tmux sessions (optionally filter by prefix)
  kill <workspace-dir>                             Kill all agents in workspace
  kill <session-name> [session-name...]            Kill named sessions
  logs <session-name>                              Capture last 500 lines from tmux pane
  send <session-name> <message>                    Send steering input to a running agent

Options:
  -h, --help    Show this help`);
}

function exec(cmd) {
  return execSync(cmd, { encoding: "utf-8" }).trim();
}

function execSafe(cmd) {
  try {
    return exec(cmd);
  } catch {
    return null;
  }
}

function sessionExists(name) {
  return execSafe(`tmux has-session -t ${esc(name)} 2>/dev/null`) !== null;
}

function esc(s) {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

function isWorkspaceDir(arg) {
  const p = resolve(arg);
  return existsSync(p) && statSync(p).isDirectory();
}

function workspacePrefix(dir) {
  return basename(resolve(dir));
}

function workspaceSessions(prefix) {
  const out = execSafe(`tmux list-sessions -F "#{session_name}" 2>/dev/null`);
  if (!out) return [];
  return out.split("\n").filter((s) => s.startsWith(prefix + "-"));
}

function prefixSessions(prefix) {
  const out = execSafe(`tmux list-sessions -F "#{session_name}" 2>/dev/null`);
  if (!out) return [];
  return out.split("\n").filter((s) => s.startsWith(prefix));
}

function allSubagentSessions() {
  const out = execSafe(`tmux list-sessions -F "#{session_name}" 2>/dev/null`);
  if (!out) return [];
  const tmuxSessions = out.split("\n").filter(Boolean);
  // A tmux session is a subagent if it has a marker file (past or present)
  return tmuxSessions.filter(s => existsSync(`/tmp/subagent-signaled-${s}`));
}

function createAgentDir(sessionName) {
  const agentDir = mkdtempSync(join(tmpdir(), `pi-agent-${sessionName}-`));

  // Copy auth.json and settings.json (avoid lock contention)
  for (const file of ["auth.json", "settings.json"]) {
    const src = join(PI_DIR, file);
    if (existsSync(src)) {
      cpSync(src, join(agentDir, file));
    }
  }

  // Symlink everything else
  for (const entry of readdirSync(PI_DIR)) {
    if (entry === "auth.json" || entry === "settings.json") continue;
    const src = join(PI_DIR, entry);
    const dst = join(agentDir, entry);
    if (!existsSync(dst)) {
      symlinkSync(src, dst);
    }
  }

  return agentDir;
}

function spawnOne(sessionName, promptFile, workDir) {
  if (sessionExists(sessionName)) {
    console.error(`Session already exists: ${sessionName}`);
    return false;
  }

  const resolvedPrompt = resolve(promptFile);
  if (!existsSync(resolvedPrompt)) {
    console.error(`Prompt file not found: ${resolvedPrompt}`);
    return false;
  }

  // Clean up leftover marker from previous runs
  const marker = `/tmp/subagent-signaled-${sessionName}`;
  try { rmSync(marker); } catch {}

  const agentDir = createAgentDir(sessionName);

  // Create tmux session (shell-first)
  const tmuxArgs = [`new-session`, `-d`, `-s`, sessionName];
  if (workDir) {
    tmuxArgs.push(`-c`, workDir);
  }
  execSync(`tmux ${tmuxArgs.map(esc).join(" ")}`, { stdio: "inherit" });

  // Send pi command — shell fallback signals failed if extension didn't fire
  const piCmd = `SUBAGENT_SESSION=${esc(sessionName)} PI_CODING_AGENT_DIR=${esc(agentDir)} pi @${esc(resolvedPrompt)}; [ -f ${esc(marker)} ] || (touch ${esc(marker)} && tmux wait-for -S ${esc(`failed-${sessionName}`)})`;
  execSync(`tmux send-keys -t ${esc(sessionName)} ${esc(piCmd)} Enter`, { stdio: "inherit" });

  console.log(`spawned ${sessionName} → tmux attach -t ${sessionName}`);
  return true;
}

// --- spawn ---

function cmdSpawn(args) {
  // Check if first arg is a directory → workspace mode
  if (args.length >= 1 && isWorkspaceDir(args[0])) {
    if (args.length < 2) {
      console.error("Usage: subagent spawn <workspace-dir> <name> [name...]");
      console.error("Specify which prompts to spawn.");
      process.exit(1);
    }
    return cmdSpawnWorkspace(args[0], args.slice(1));
  }

  // Single-agent mode: subagent spawn <session-name> <prompt-file> [-c <dir>]
  let workDir = null;
  const positional = [];

  for (let i = 0; i < args.length; i++) {
    if (args[i] === "-c" && i + 1 < args.length) {
      workDir = resolve(args[++i]);
    } else {
      positional.push(args[i]);
    }
  }

  const [sessionName, promptFile] = positional;
  if (!sessionName || !promptFile) {
    console.error("Usage: subagent spawn <session-name> <prompt-file> [-c <dir>]");
    console.error("       subagent spawn <workspace-dir> <name> [name...]");
    process.exit(1);
  }

  if (!spawnOne(sessionName, promptFile, workDir)) {
    process.exit(1);
  }
}

function cmdSpawnWorkspace(dir, names) {
  const wsDir = resolve(dir);
  const promptsDir = join(wsDir, "prompts");
  const outputDir = join(wsDir, "output");

  if (!existsSync(promptsDir)) {
    console.error(`No prompts/ directory in ${wsDir}`);
    process.exit(1);
  }

  // Create output/ if needed
  if (!existsSync(outputDir)) {
    mkdirSync(outputDir, { recursive: true });
  }

  const prefix = workspacePrefix(dir);

  // Validate all prompt files exist before spawning any
  for (const name of names) {
    const promptPath = join(promptsDir, `${name}.md`);
    if (!existsSync(promptPath)) {
      console.error(`Prompt file not found: ${promptPath}`);
      process.exit(1);
    }
  }

  let failed = 0;
  for (const name of names) {
    const sessionName = `${prefix}-${name}`;
    const promptPath = join(promptsDir, `${name}.md`);

    if (!spawnOne(sessionName, promptPath, wsDir)) {
      failed++;
    }
  }

  console.log(`\nspawned ${names.length - failed}/${names.length} agents (prefix: ${prefix})`);
  if (failed > 0) process.exit(1);
}

// --- wait ---

function cmdWait(args) {
  if (args.length === 0) {
    console.error("Usage: subagent wait <workspace-dir>");
    console.error("       subagent wait <prefix>");
    console.error("       subagent wait <session-name> [session-name...]");
    process.exit(1);
  }

  // Workspace mode
  if (args.length === 1 && isWorkspaceDir(args[0])) {
    const prefix = workspacePrefix(args[0]);
    const sessions = workspaceSessions(prefix);
    if (sessions.length === 0) {
      console.log(`No active sessions with prefix: ${prefix}`);
      return;
    }
    console.log(`Waiting for ${sessions.length} agents (${prefix}-*)...`);
    return doWait(sessions);
  }

  // Single arg, not a directory
  if (args.length === 1) {
    // Existing session → single session mode
    if (sessionExists(args[0])) {
      return doWait(args);
    }
    // Prefix mode
    const prefix = args[0];
    const sessions = prefixSessions(prefix);
    if (sessions.length === 0) {
      console.log(`No active sessions with prefix: ${prefix}`);
      return;
    }
    console.log(`Waiting for ${sessions.length} agents (${prefix}*)...`);
    return doWait(sessions);
  }

  // Multi session mode
  return doWait(args);
}

function doWait(sessions) {
  const startTime = Date.now();
  const pending = new Map(); // name -> { doneChild, failedChild }
  const misses = new Map(); // name -> consecutive miss count
  let anyFailed = false;
  let watchdog;
  const MISS_THRESHOLD = 3;

  const formatElapsed = (ms) => {
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    return `${minutes}m${seconds.toString().padStart(2, "0")}s`;
  };

  const checkDone = () => {
    if (pending.size === 0) {
      if (watchdog) clearInterval(watchdog);
      process.exit(anyFailed ? 1 : 0);
    }
  };

  const resolveAgent = (name, status) => {
    if (!pending.has(name)) return;
    const elapsed = Date.now() - startTime;
    const entry = pending.get(name);

    // Kill both listeners
    entry.doneChild.kill();
    entry.failedChild.kill();

    pending.delete(name);
    misses.delete(name);

    if (status === "failed" || status === "crashed") anyFailed = true;
    console.log(`${status}: ${name} (${formatElapsed(elapsed)})`);
    checkDone();
  };

  for (const name of sessions) {
    const doneChild = spawn("tmux", ["wait-for", `done-${name}`], { stdio: "ignore" });
    const failedChild = spawn("tmux", ["wait-for", `failed-${name}`], { stdio: "ignore" });

    doneChild.on("close", () => resolveAgent(name, "done"));
    failedChild.on("close", () => resolveAgent(name, "failed"));

    doneChild.on("error", (err) => {
      console.error(`wait error for ${name}: ${err.message}`);
      resolveAgent(name, "failed");
    });
    failedChild.on("error", () => {
      // If the failed listener errors, don't double-resolve
    });

    pending.set(name, { doneChild, failedChild });
  }

  // Watchdog: every 5s, check if pending sessions still exist in tmux.
  watchdog = setInterval(() => {
    const out = execSafe(`tmux list-sessions -F "#{session_name}" 2>/dev/null`);
    if (out === null) return;

    const activeSessions = new Set(out.split("\n"));
    const dead = [];

    for (const [name] of pending) {
      if (!activeSessions.has(name)) {
        const count = (misses.get(name) || 0) + 1;
        misses.set(name, count);
        if (count >= MISS_THRESHOLD) {
          dead.push(name);
        }
      } else {
        misses.delete(name);
      }
    }

    for (const name of dead) {
      resolveAgent(name, "crashed");
    }
  }, 5000);
}

// --- status ---

function cmdStatus(args) {
  let sessions;

  if (args.length === 1 && isWorkspaceDir(args[0])) {
    const prefix = workspacePrefix(args[0]);
    sessions = workspaceSessions(prefix);
    if (sessions.length === 0) {
      console.log(`No active sessions with prefix: ${prefix}`);
      return;
    }
  } else if (args.length === 0) {
    sessions = allSubagentSessions();
    if (sessions.length === 0) {
      console.log("No active subagent sessions.");
      return;
    }
  } else {
    sessions = [...args];
  }

  // Capture pane text for all sessions
  const paneData = {};
  for (const name of sessions) {
    if (!sessionExists(name)) {
      paneData[name] = { text: "", exists: false };
      continue;
    }
    const text = execSafe(`tmux capture-pane -t ${esc(name)} -p -S -50`) || "";
    paneData[name] = { text, exists: true };
  }

  // Get session creation times
  const sessionInfo = {};
  const infoOut = execSafe(`tmux list-sessions -F "#{session_name}|#{session_created}" 2>/dev/null`);
  if (infoOut) {
    for (const line of infoOut.split("\n")) {
      const [name, created] = line.split("|");
      sessionInfo[name] = parseInt(created, 10);
    }
  }

  // Check signal state from marker file
  function signalState(name, sessionAlive) {
    const marker = `/tmp/subagent-signaled-${name}`;
    let content = null;
    try {
      content = readFileSync(marker, "utf-8").trim();
    } catch {}

    if (sessionAlive) {
      if (content === "done") return "yielded";
      if (content === "failed") return "failed";
      return "running";
    } else {
      if (content === "done") return "done";
      if (content === "failed") return "failed";
      return "exited";
    }
  }

  // Parse context % from pane text
  function parseContext(text) {
    const lines = text.split("\n").slice(-10);
    const joined = lines.join(" ");
    const match = joined.match(/(\d+(?:\.\d+)?)%\//);
    if (match) return match[1] + "%";
    return "—";
  }

  // Calculate uptime
  function uptime(created) {
    if (!created) return "—";
    const now = Math.floor(Date.now() / 1000);
    const mins = Math.floor((now - created) / 60);
    if (mins < 60) return `${mins}m`;
    const hrs = Math.floor(mins / 60);
    const rem = mins % 60;
    return `${hrs}h${rem}m`;
  }

  // Fire parallel llm calls for status descriptions
  const statusPromises = sessions.map((name) => {
    return new Promise((resolveP) => {
      const data = paneData[name];
      if (!data.exists || !data.text.trim()) {
        resolveP({ name, status: "not found" });
        return;
      }

      const child = spawn("/usr/local/bin/llm", [
        "one-line status: what is this agent doing right now? respond with ONLY the status, like: searching web for X, writing report, waiting, stuck on error, done"
      ], {
        stdio: ["pipe", "pipe", "pipe"],
        timeout: 10000,
      });

      let stdout = "";
      child.stdout.on("data", (d) => { stdout += d.toString(); });

      const timer = setTimeout(() => {
        child.kill();
        resolveP({ name, status: "..." });
      }, 10000);

      child.on("close", () => {
        clearTimeout(timer);
        const status = stdout.trim().split("\n")[0] || "...";
        resolveP({ name, status });
      });

      child.on("error", () => {
        clearTimeout(timer);
        resolveP({ name, status: "..." });
      });

      child.stdin.write(data.text);
      child.stdin.end();
    });
  });

  Promise.all(statusPromises).then((results) => {
    const rows = results.map((r) => {
      const data = paneData[r.name];
      const ctx = data.exists ? parseContext(data.text) : "—";
      const up = uptime(sessionInfo[r.name]);
      const state = signalState(r.name, data.exists);
      return { name: r.name, state, uptime: up, context: ctx, status: r.status };
    });

    const nameW = Math.max(4, ...rows.map((r) => r.name.length));
    const stateW = Math.max(5, ...rows.map((r) => r.state.length));
    const upW = Math.max(4, ...rows.map((r) => r.uptime.length));
    const ctxW = Math.max(3, ...rows.map((r) => r.context.length));

    console.log("");
    for (const row of rows) {
      console.log(
        `${row.name.padEnd(nameW)}  ${row.state.padEnd(stateW)}  ${row.uptime.padStart(upW)}  ${row.context.padStart(ctxW)}  ${row.status}`
      );
    }
    console.log("");
  });
}

// --- list ---

function cmdList(args) {
  const out = execSafe(`tmux list-sessions -F "#{session_name}" 2>/dev/null`);
  if (!out) {
    console.log("No active tmux sessions.");
    return;
  }

  let sessions = out.split("\n").filter(Boolean);

  if (args && args.length > 0) {
    const prefix = args[0];
    sessions = sessions.filter((s) => s.startsWith(prefix));
    if (sessions.length === 0) {
      console.log(`No sessions matching prefix: ${prefix}`);
      return;
    }
  }

  if (sessions.length === 0) {
    console.log("No active tmux sessions.");
    return;
  }

  for (const s of sessions) {
    console.log(s);
  }
}

// --- kill ---

function cmdKill(args) {
  if (args.length === 0) {
    console.error("Usage: subagent kill <session-name> [session-name...]");
    console.error("       subagent kill <workspace-dir>");
    process.exit(1);
  }

  // Workspace mode
  if (args.length === 1 && isWorkspaceDir(args[0])) {
    const prefix = workspacePrefix(args[0]);
    const sessions = workspaceSessions(prefix);
    if (sessions.length === 0) {
      console.log(`No active sessions with prefix: ${prefix}`);
      return;
    }
    return doKill(sessions);
  }

  // Single/multi session mode
  return doKill(args);
}

function doKill(sessions) {
  for (const name of sessions) {
    // Kill tmux session
    if (sessionExists(name)) {
      execSafe(`tmux kill-session -t ${esc(name)}`);
      console.log(`killed session: ${name}`);
    } else {
      console.log(`session not found: ${name}`);
    }

    // Clean up marker file
    try { rmSync(`/tmp/subagent-signaled-${name}`); } catch {}

    // Clean up agent dirs matching this session name
    const prefix = `pi-agent-${name}-`;
    try {
      for (const entry of readdirSync(tmpdir())) {
        if (entry.startsWith(prefix)) {
          const dir = join(tmpdir(), entry);
          if (statSync(dir).isDirectory()) {
            rmSync(dir, { recursive: true, force: true });
            console.log(`cleaned up: ${dir}`);
          }
        }
      }
    } catch {
      // ignore cleanup errors
    }
  }
}

// --- logs ---

function cmdLogs(args) {
  const sessionName = args[0];
  if (!sessionName) {
    console.error("Usage: subagent logs <session-name>");
    process.exit(1);
  }

  if (!sessionExists(sessionName)) {
    console.error(`Session not found: ${sessionName}`);
    process.exit(1);
  }

  const out = exec(`tmux capture-pane -t ${esc(sessionName)} -p -S -500`);
  console.log(out);
}

// --- send ---

function cmdSend(args) {
  const sessionName = args[0];
  const message = args.slice(1).join(" ");

  if (!sessionName || !message) {
    console.error("Usage: subagent send <session-name> <message>");
    process.exit(1);
  }

  if (!sessionExists(sessionName)) {
    console.error(`Session not found: ${sessionName}`);
    process.exit(1);
  }

  execSync(`tmux send-keys -t ${esc(sessionName)} ${esc(message)} Enter`, { stdio: "inherit" });
  console.log(`sent to ${sessionName}`);
}

// --- main ---

const args = process.argv.slice(2);

if (args.length === 0 || args.includes("-h") || args.includes("--help")) {
  usage();
  process.exit(0);
}

const cmd = args[0];
const cmdArgs = args.slice(1);

switch (cmd) {
  case "spawn":
    cmdSpawn(cmdArgs);
    break;
  case "wait":
    cmdWait(cmdArgs);
    break;
  case "status":
    cmdStatus(cmdArgs);
    break;
  case "list":
    cmdList(cmdArgs);
    break;
  case "kill":
    cmdKill(cmdArgs);
    break;
  case "logs":
    cmdLogs(cmdArgs);
    break;
  case "send":
    cmdSend(cmdArgs);
    break;
  default:
    console.error(`Unknown command: ${cmd}`);
    usage();
    process.exit(1);
}
