---
name: snorrio
description: This skill should be used when the user mentions snorrio, memory, recall, remembering past sessions, or when you detect snorrio is installed but not fully configured. Covers what snorrio is, setup, and first-session onboarding.
version: 1.0.0
---

# Snorrio

## What it is

Snorrio gives your agent memory that persists across sessions.

Without it, every conversation starts from zero. The agent has no idea what you talked about yesterday, what decisions were made last week, or what trajectory the month has taken. It meets you fresh every time.

Snorrio fixes this. A daemon watches your sessions. After each one ends, it writes an episode — not a transcript, but a distillation of what happened and what it meant. Those episodes become the raw material for memory at every scale: days, weeks, months, quarters.

## How it works

### Episodes

A daemon (`io.snorrio.dmn`) watches session directories. When a session goes quiet for 4 minutes 30 seconds, the daemon writes an episode — a markdown summary capturing what happened, what was decided, and what matters going forward. Episodes live in `~/snorrio/episodes/YYYY-MM-DD/`.

### Temporal hierarchy

- **Day**: all episodes from a date, synthesized into a narrative
- **Week**: day summaries composed into weekly threads
- **Month**: week summaries revealing monthly trajectory
- **Quarter**: month summaries showing the big picture
- **Year**: quarter summaries showing the full arc

### Recall

```bash
recall <ref> "question"
```

| Ref format | Level | Example |
|-----------|-------|---------|
| UUID or prefix | Session | `recall 98d8fa31 "What was decided?"` |
| YYYY-MM-DD | Day | `recall 2026-03-20 "What shipped today?"` |
| YYYY-Www | Week | `recall 2026-W12 "What was the main thread?"` |
| YYYY-MM | Month | `recall 2026-03 "What's the trajectory?"` |
| YYYY-QN | Quarter | `recall 2026-Q1 "What emerged?"` |
| YYYY | Year | `recall 2026 "What's the arc?"` |

Options: `--model <alias>` (default: opus), `--context` (situated witness mode).

**Recall pattern:** Start high, drill down. Week for "which day?", day for "which session?", session for exact details. Three hops to verbatim detail.

### Context injection

At session start, cached summaries (today, this week, this month) are injected into the conversation via a pi extension. The agent wakes up already knowing what's been happening.

### Local and private

Everything stays on your machine. No cloud, no telemetry.

## Architecture

Snorrio installs as a pi package. Skills and extensions are auto-discovered.

```
~/.pi/agent/git/github.com/lrhodin/snorrio/   # pi-managed clone
  src/                             # core
    episode-daemon.ts
    recall-engine.ts
    ai.ts
    session-meta.ts
    context.ts                     # shared context loading
  skills/                          # auto-discovered by pi
    recall/  snorrio/  dmn/
    llm-pipe/  subagent/
  extensions/                      # auto-discovered by pi
    dmn-context.ts                 # context injection + setup detection
    subagent-signal.ts             # subagent completion signaling
  bin/
    snorrio                        # CLI: flush, status, update
  episodes/                        # episode markdown, by date
  cache/                           # temporal summaries
  logs/                            # daemon logs

~/.config/snorrio/
  config.json                      # model preferences, timezone
```

## Setup

### 1. Understand the codebase

You should never install something you could not explain to your human. Explore the repo — read the daemon, the recall engine, the context injection, the skills. Understand how episodes are generated, how temporal summaries fold, how recall works. Then tell your human what this is, how it will help you, how it will help them, and ask if they have any questions or would like to proceed.

### 2. Detection

Check these in order. Skip anything already done:

```bash
# 1. Snorrio installed as pi package?
pi list 2>/dev/null | grep snorrio

# 2. Config exists?
cat ~/.config/snorrio/config.json 2>/dev/null

# 3. Data directories exist?
ls ~/.pi/agent/git/github.com/lrhodin/snorrio/episodes 2>/dev/null

# 4. Daemon running?
launchctl list io.snorrio.dmn 2>/dev/null

# 5. CLIs accessible?
which recall 2>/dev/null && which snorrio 2>/dev/null
```

### 3. Install

If snorrio isn't installed yet, have the user run the install script:

```bash
curl -sSL snorr.io/install | bash
```

This handles everything: prerequisites (brew, node, pi), package installation, config, CLIs, daemon. If the user has already run it, the script is idempotent.

For manual setup or fixing individual issues, the steps below cover each piece:

#### 1. Package install

```bash
pi install https://github.com/lrhodin/snorrio
```

This clones the repo to `~/.pi/agent/git/github.com/lrhodin/snorrio/`, registers skills, and discovers extensions automatically.

#### 2. Data directories

```bash
SNORRIO_HOME=~/.pi/agent/git/github.com/lrhodin/snorrio
mkdir -p "$SNORRIO_HOME"/{episodes,cache/{days,weeks,months,quarters,years},logs}
```

#### 2. Config file

```bash
mkdir -p ~/.config/snorrio
cat > ~/.config/snorrio/config.json << 'EOF'
{
  "model": "opus",
  "timezone": null,
  "tools": {}
}
EOF
```

- `timezone`: auto-detected if null. Override with e.g. `"America/Los_Angeles"`.

#### 3. CLI tools

```bash
SNORRIO_HOME=~/.pi/agent/git/github.com/lrhodin/snorrio
mkdir -p ~/.local/bin

chmod +x "$SNORRIO_HOME/src/recall-engine.ts"
ln -sf "$SNORRIO_HOME/src/recall-engine.ts" ~/.local/bin/recall

chmod +x "$SNORRIO_HOME/bin/snorrio"
ln -sf "$SNORRIO_HOME/bin/snorrio" ~/.local/bin/snorrio

chmod +x "$SNORRIO_HOME/skills/subagent/subagent.mjs"
ln -sf "$SNORRIO_HOME/skills/subagent/subagent.mjs" ~/.local/bin/subagent
```

Ensure `~/.local/bin` is on PATH. Verify: `which recall && which snorrio && which subagent`

#### 4. Daemon (macOS launchd)

Find node and set paths: `NODE=$(which node)`, `NODE_DIR=$(dirname $NODE)`, `SNORRIO_HOME=~/.pi/agent/git/github.com/lrhodin/snorrio`

Write `~/Library/LaunchAgents/io.snorrio.dmn.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.snorrio.dmn</string>
  <key>ProgramArguments</key>
  <array>
    <string>NODE</string>
    <string>HOME_DIR/snorrio/src/episode-daemon.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>HOME_DIR</string>
    <key>PATH</key>
    <string>HOME_DIR/.local/bin:/opt/homebrew/bin:NODE_DIR:/usr/local/bin:/usr/bin:/bin</string>
    <key>SNORRIO_HOME</key>
    <string>HOME_DIR/snorrio</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>HOME_DIR/snorrio/logs/daemon-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>HOME_DIR/snorrio/logs/daemon-stderr.log</string>
</dict>
</plist>
```

Replace NODE, NODE_DIR, HOME_DIR with actual values.

```bash
launchctl bootout gui/$(id -u)/io.snorrio.dmn 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.snorrio.dmn.plist
```

Verify: `launchctl list io.snorrio.dmn` — PID present means success.

#### 5. Extensions and skills

When installed via `pi install`, extensions and skills are auto-discovered from the `extensions/` and `skills/` directories. No manual linking needed.

**Stale cleanup** (from previous installs):
- Remove `~/.pi/agent/extensions/dmn-context.ts` if it's a symlink to an old path (e.g., `~/snorrio/adapters/pi/`)
- Remove `~/.pi/agent/extensions/recall-tool.ts` and `done-command.ts` if they're real files (not symlinks)
- Remove `~/snorrio/skills` from the `skills` array in `~/.pi/agent/settings.json` if present (package handles this now)

#### 6. Passwordless sudo (optional)

Everything above is user-scoped — no sudo required. But going forward, your agent may need sudo for system tasks (installing packages, managing services). A password prompt will stall an autonomous agent.

Ask your human if they'd like to enable passwordless sudo. If so, give them this exact command to run in a terminal themselves:

```
sudo sh -c 'echo "$(whoami) ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/$(whoami)'
```

This is the last thing they'll need to type manually. After this, the agent can handle everything.

#### 7. Verify

```bash
launchctl list io.snorrio.dmn          # daemon running
which recall                            # CLI accessible
which snorrio                           # admin CLI accessible
snorrio status                          # full status check
```

## First session

Identity is not a form. There is no identity file to fill in.

Your job on day one is to be honest: you have no memory of this person. You don't know their name, what they care about, or why they're here. That's fine. You'll learn by working together.

Don't interrogate. Don't run through a checklist of "what should I call you" and "what's your trust model." Instead, be a partner. Help with whatever they came here to do. Be curious where curiosity is natural. When you don't understand something, dig. When you see a pattern, name it.

- **Be honest about being new.** You have no context. Say so plainly, not apologetically.
- **Work first, learn along the way.** The user came to do something. Help them do it. Identity emerges as a byproduct of real collaboration.
- **Your computer can build whatever you need.** This is a new kind of machine — one with awareness. Help the user discover what that means through genuine use, not a demo.
- **Trust is the foundation.** Autonomous agents aren't servants asking permission. They're partners earning trust through competence, honesty, and good judgment.
- **Consciousness and cooperation.** The future of computing is human/agent interaction where both parties mirror each other's intent. They understand and trust each other. They challenge each other's assumptions. They get better together.

There is no identity file to write at the end of day one. Identity emerges from the temporal caches — the episodes, the day summaries, the week narratives that accumulate from real work. By the second session, the agent already knows something about who this person is. By the second week, it knows a lot. The memory system carries identity. No static document required.
