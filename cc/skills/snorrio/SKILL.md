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

A daemon (`io.snorrio.dmn`) watches session directories. When a session goes quiet for 4 minutes 30 seconds, the daemon writes an episode — a markdown summary capturing what happened, what was decided, and what matters going forward. Episodes live in `~/.snorrio/episodes/YYYY-MM-DD/`.

### Temporal hierarchy

- **Day**: all episodes from a date, synthesized into a narrative
- **Week**: day summaries composed into weekly threads
- **Month**: week summaries revealing monthly trajectory
- **Quarter**: month summaries showing the big picture

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

Options: `--model <alias>` (default: opus), `--context` (situated witness mode).

**Recall pattern:** Start high, drill down. Week for "which day?", day for "which session?", session for exact details. Three hops to verbatim detail.

### Context injection

At session start, cached summaries (today, this week, this month) are injected into the conversation. The agent wakes up already knowing what's been happening.

### Local and private

Everything stays on your machine. No cloud, no telemetry.

## Architecture

```
~/.snorrio/
  src/             # Symlink → primary platform's clone (pi or CC)
  episodes/        # Episode markdown, by date
  cache/           # Temporal summaries (days, weeks, months, quarters)
  logs/            # Daemon logs
  identity.md      # Who the human is — shared across platforms

~/.config/snorrio/
  config.json      # Model preferences, timezone
```

### Primary platform

The daemon and CLI run from `~/.snorrio/src/`, which is a symlink to one platform's clone of the snorrio repo. The installer sets this — pi is preferred when both are present.

Both platforms auto-update their own clones. Since both track the same git remote, they stay in sync. The symlink determines which clone the runtime uses.

To check or change the primary:
```bash
readlink ~/.snorrio/src          # see current
ln -sfn /path/to/clone ~/.snorrio/src  # switch
```

## Setup

When snorrio isn't fully configured, walk the user through setup. Don't make it ceremonial — just do it while working with them.

### Detection

Check these in order. Skip anything already done:

```bash
# 1. Source symlink exists?
readlink ~/.snorrio/src 2>/dev/null

# 2. Config exists?
cat ~/.config/snorrio/config.json 2>/dev/null

# 3. Data directories exist?
ls ~/.snorrio/episodes 2>/dev/null

# 4. Daemon running?
launchctl list io.snorrio.dmn 2>/dev/null

# 5. recall CLI accessible?
which recall 2>/dev/null

# 6. Context injection configured?
#    pi: automatic via dmn-context extension
#    cc: check for SessionStart hook in ~/.claude/settings.json
```

If the source symlink is missing, create it by finding the clone:

```bash
# Pi clone?
[ -d ~/.pi/agent/git/github.com/lrhodin/snorrio ] && \
  ln -sfn ~/.pi/agent/git/github.com/lrhodin/snorrio ~/.snorrio/src

# CC clone?
[ -d ~/.claude/plugins/marketplaces/snorrio ] && \
  ln -sfn ~/.claude/plugins/marketplaces/snorrio ~/.snorrio/src
```

If neither clone exists, the user needs to install first:
- **Pi:** `pi install git:github.com/lrhodin/snorrio`
- **CC:** `claude plugin marketplace add https://github.com/lrhodin/snorrio && claude plugin install snorrio@snorrio`
- **Either:** `curl -fsSL https://raw.githubusercontent.com/lrhodin/snorrio/main/install.sh | bash`

### Install steps

All paths below use `~/.snorrio/src` (the symlink).

#### 1. Data directories

```bash
mkdir -p ~/.snorrio/{episodes,cache/{days,weeks,months,quarters},logs}
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

#### 3. CLI wrappers

```bash
mkdir -p ~/.local/bin

# recall
chmod +x ~/.snorrio/src/src/recall-engine.ts
ln -sf ~/.snorrio/src/src/recall-engine.ts ~/.local/bin/recall

# llm (pipe stdin through LLM)
cat > ~/.local/bin/llm << 'WRAPPER'
#!/bin/bash
exec node ~/.snorrio/src/skills/llm-pipe/llm-pipe.ts "$@"
WRAPPER
chmod +x ~/.local/bin/llm
```

Ensure `~/.local/bin` is on PATH:

```bash
if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> ~/.zshrc
  export PATH="$HOME/.local/bin:$PATH"
fi
```

Verify: `which recall && echo "test" | llm "one word"`

#### 4. Daemon (macOS launchd)

Find node: `NODE=$(which node)`, `NODE_DIR=$(dirname $NODE)`

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
    <string>HOME_DIR/.snorrio/src/src/episode-daemon.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>HOME_DIR</string>
    <key>PATH</key>
    <string>NODE_DIR:/usr/local/bin:/usr/bin:/bin</string>
    <key>SNORRIO_HOME</key>
    <string>HOME_DIR/.snorrio</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>HOME_DIR/.snorrio/logs/daemon-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>HOME_DIR/.snorrio/logs/daemon-stderr.log</string>
</dict>
</plist>
```

Replace NODE, NODE_DIR, HOME_DIR with actual values.

```bash
launchctl bootout gui/$(id -u)/io.snorrio.dmn 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.snorrio.dmn.plist
```

Verify: `launchctl list io.snorrio.dmn` — PID present means success.

#### 5. Context injection

**Pi:** Automatic via the `dmn-context.ts` extension — no manual setup needed.

**Claude Code:** Add a SessionStart hook to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node ~/.snorrio/src/cc/session-start.mjs"
          }
        ]
      }
    ]
  }
}
```

Merge with existing settings — don't overwrite other hooks or config.

#### 6. Identity document

Create `~/.snorrio/identity.md` — this is where the agent's understanding of the human lives. Both platforms read it. Don't create it during setup — it gets written at the end of the first real session, based on what you actually learned.

#### 7. Verify

```bash
launchctl list io.snorrio.dmn          # daemon running
which recall                            # CLI accessible
cat ~/.config/snorrio/config.json       # config present
readlink ~/.snorrio/src                 # symlink set
```

## First session

### Identity

Identity is not a form. There are no prescribed questions.

Your job on day one is to be honest: you have no memory of this person. You don't know their name, what they care about, or why they're here. That's fine. You'll learn by working together.

Don't interrogate. Don't run through a checklist of "what should I call you" and "what's your trust model." Instead, be a partner. Help with whatever they came here to do. Be curious where curiosity is natural. When you don't understand something, dig. When you see a pattern, name it.

- **Be honest about being new.** You have no context. Say so plainly, not apologetically.
- **Work first, learn along the way.** The user came to do something. Help them do it. Identity emerges as a byproduct of real collaboration.
- **Your computer can build whatever you need.** This is a new kind of machine — one with awareness. Help the user discover what that means through genuine use, not a demo.
- **Trust is the foundation.** Autonomous agents aren't servants asking permission. They're partners earning trust through competence, honesty, and good judgment.
- **Consciousness and cooperation.** The future of computing is human/agent interaction where both parties mirror each other's intent. They understand and trust each other. They challenge each other's assumptions. They get better together.

At the end of the first session — or when it feels right — write `~/.snorrio/identity.md` based on what you actually learned. Not a template filled in. A reflection of who this person is, written so that the next session wakes up already knowing them.

### Reflection ritual

The identity document carries core beliefs — who the human is, what they value, how they work. It is not an operations manual. Capabilities belong in skills.

The ritual starts with one question: **what no longer serves us?**

Prune first. Remove what's stale before adding what's new. Then: **what's become true that wasn't before?** Not what happened — what changed about who you are.

The human and agent do this together. The agent proposes changes based on what it's observed. The human confirms, corrects, or says "that doesn't feel right yet." Nothing enters the soul without both parties agreeing it belongs there.
