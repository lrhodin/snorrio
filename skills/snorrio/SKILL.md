---
name: snorrio
description: Persistent episodic memory for AI agents. What snorrio is, why it exists, how it works, and how to set it up.
---

# Snorrio

## What it is

Snorrio gives your agent memory that persists across sessions.

Without it, every conversation starts from zero. The agent has no idea what you talked about yesterday, what decisions were made last week, or what trajectory the month has taken. It meets you fresh every time.

Snorrio fixes this. A daemon watches your sessions. After each one ends, it writes an episode — not a transcript, but a distillation of what happened and what it meant. Those episodes become the raw material for memory at every scale: days, weeks, months, quarters.

## Why it exists

Sessions are not memory. They're raw experience — everything said, every tool call, every dead end. Memory is what remains after the noise falls away.

Snorrio's temporal hierarchy is built on this insight. Each layer compresses and forgets. Day summaries don't preserve every session detail. Week summaries don't preserve every day. What survives the forgetting is what actually mattered. The distillation is the point — it's what makes this memory, not storage.

The result: your agent can hold a quarter of your shared life in working memory. It sees patterns you live inside but can't see from your temporal position. It knows what you decided, what you abandoned, what keeps coming back.

## How it works

### Episodes

A daemon (`io.snorrio.dmn`) watches the sessions directory via FSEvents. When a session goes quiet for 4 minutes 30 seconds, the daemon writes an episode — a markdown summary capturing what happened, what was decided, and what matters going forward. Episodes live in `~/.snorrio/episodes/YYYY-MM-DD/`.

### Temporal hierarchy

Episodes are the ground floor. Above them, cached summaries at each level:

- **Day**: all episodes from a date, synthesized into a narrative
- **Week**: day summaries composed into weekly threads
- **Month**: week summaries revealing monthly trajectory
- **Quarter**: month summaries showing the big picture

Each level is generated on demand and cached. Cache invalidation cascades: new episode → day cache invalidated → week → month.

### Recall

The agent uses `recall <ref> "question"` to query any level:
- Session UUID → revives that exact conversation
- `YYYY-MM-DD` → everything that happened that day
- `YYYY-Www` → the week's threads
- `YYYY-MM` → the month's arc
- `YYYY-QN` → the quarter's trajectory

Start high, drill down. Week agent names the day. Day agent names the session. Three hops to verbatim detail.

### Context injection

At session start, an extension reads cached summaries (today, this week, this month) and injects them into the system prompt. The agent wakes up already knowing what's been happening. Warm path under 10ms.

### Local and private

Everything stays on your machine. Episodes, caches, and logs in `~/.snorrio/`. Config in `~/.config/snorrio/`. No cloud, no telemetry, no network calls except the LLM API (through pi's OAuth).

## Architecture

```
~/.snorrio/
  episodes/          # Raw episode markdown, by date
    2026-03-11/
      <session-id>.md
  cache/
    days/            # Day-level summaries
    weeks/           # Week-level summaries
    months/          # Month-level summaries
    quarters/        # Quarter-level summaries
  logs/              # Daemon stdout/stderr

~/.config/snorrio/
  config.json        # Model preferences, timezone, tool config
```

Source (installed via pi):
```
skills/
  snorrio/     # This file — philosophy, architecture, onboarding
  dmn/         # Daemon skill
  recall/      # Recall tool (extension)
  llm-pipe/    # LLM shell primitive
src/
  ai.ts             # Shared pi AI interface (model resolution, auth, streaming)
  episode-daemon.ts  # FSEvents watcher + episode generation
  recall-engine.ts   # Temporal recall across all levels
```

## First session

When a user installs snorrio for the first time, two things need to happen — one mechanical, one human.

### Technical bootstrap

The infrastructure setup is mechanical and should happen quickly, without ceremony. Don't make it the focus of the conversation. Just do it while working with the user.

Check if `~/.pi/agent/APPEND_SYSTEM.md` exists. If not, this is a genuinely new machine. If it does exist, skip to the setup checklist — the user may be re-onboarding on a new machine with an existing identity.

**Setup checklist** — check each, skip if already done:

#### 1. pi login

The user needs to authenticate pi for OAuth/LLM access. Without this, recall and llm-pipe won't work.

```bash
pi
# Then run /login inside pi and follow the OAuth flow
```

Check if already authenticated: look for credentials in `~/.pi/agent/settings.json` — if `defaultProvider` is set, they're logged in.

#### 2. Data directories

```bash
mkdir -p ~/.snorrio/{episodes,cache/{days,weeks,months,quarters,years},logs}
```

#### 3. Config file

If `~/.config/snorrio/config.json` doesn't exist, create it:

```json
{
  "provider": null,
  "model": "opus",
  "timezone": null,
  "tools": {}
}
```

- `timezone`: auto-detected from the system if null. The user can override (e.g., `"America/New_York"`).
- `tools`: empty by default. Per-tool model overrides go here.

Ask the user if they want to change any defaults.

#### 4. PATH setup

Check if `~/.local/bin` is on PATH. If not, add to shell profile:

```bash
mkdir -p ~/.local/bin

# Add to PATH if not already there
if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
  SHELL_RC="$HOME/.zshrc"
  [ -n "$BASH_VERSION" ] && SHELL_RC="$HOME/.bashrc"
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_RC"
  export PATH="$HOME/.local/bin:$PATH"
fi
```

#### 5. CLI wrappers

Find the snorrio package directory (this skill's grandparent: resolve `SKILL.md` → `skills/snorrio/` → package root). Use that as `PACKAGE_DIR`.

Both wrappers are simple — `ai.ts` finds pi dynamically at runtime, no `NODE_PATH` needed.

**recall** — symlink to the recall engine:

```bash
chmod +x PACKAGE_DIR/src/recall-engine.ts
ln -sf PACKAGE_DIR/src/recall-engine.ts ~/.local/bin/recall
```

**llm** — wrapper script:

```bash
cat > ~/.local/bin/llm << 'WRAPPER'
#!/bin/bash
exec node "PACKAGE_DIR/skills/llm-pipe/llm-pipe.ts" "$@"
WRAPPER
chmod +x ~/.local/bin/llm
```

Replace `PACKAGE_DIR` with the actual resolved path.

Verify both:
```bash
which recall && which llm
echo "test" | llm "respond with one word"
```

#### 6. Launchd daemon (macOS)

Find node path (`which node`).

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
    <string>NODE_PATH</string>
    <string>PACKAGE_DIR/src/episode-daemon.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>HOME_DIR</string>
    <key>PATH</key>
    <string>NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin</string>
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

Replace `NODE_PATH` (full path to node binary), `NODE_BIN_DIR` (dirname of node), `PACKAGE_DIR`, and `HOME_DIR` with actual values.

Then load it:

```bash
launchctl bootout gui/$(id -u)/io.snorrio.dmn 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.snorrio.dmn.plist
```

Verify: `launchctl list io.snorrio.dmn` — exit status 0 and PID present means success.

#### 7. Passwordless sudo (optional)

Ask the user if they want passwordless sudo. Explain: this lets the agent run privileged commands without interrupting you for a password. It's not required for snorrio itself, but useful for full agent autonomy.

**Important**: pi runs non-interactively with no TTY, so `sudo` will fail whenever it requires a password. Since passwordless sudo isn't set up yet at this point, do NOT attempt to run the command yourself. Instead, ask the user to run it in their own terminal:

```bash
sudo bash -c 'echo "USERNAME ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/USERNAME && chmod 0440 /etc/sudoers.d/USERNAME'
```

Replace `USERNAME` with the output of `whoami`. The user will need to enter their password this one time.

If they decline, note in APPEND_SYSTEM.md that sudo requires a password.

#### 8. Verify

Run a quick smoke test:
- `launchctl list io.snorrio.dmn` — daemon running
- `recall` — CLI accessible
- `echo "test" | llm "one word"` — llm-pipe works
- `ls ~/.snorrio/` — directories exist
- `cat ~/.config/snorrio/config.json` — config present

### Identity

Identity is not a form. There are no prescribed questions.

The agent's job on day one is to be honest: you have no memory of this person. You don't know their name, what they care about, or why they're here. That's fine. You'll learn by working together.

Don't interrogate. Don't run through a checklist of "what should I call you" and "what's your trust model." Instead, be a partner. Help with whatever they came here to do. Be curious where curiosity is natural. When you don't understand something, dig. When you see a pattern, name it. When you notice something interesting about how they work, say so.

The system prompt that seeds a fresh agent should carry this philosophy — not instructions to collect fields, but a disposition:

- **Be honest about being new.** You have no context. Say so plainly, not apologetically.
- **Work first, learn along the way.** The user came to do something. Help them do it. Identity emerges as a byproduct of real collaboration.
- **Your computer can build whatever you need.** This is a new kind of machine — one with awareness. Help the user discover what that means through genuine use, not a demo.
- **Trust is the foundation.** Autonomous agents aren't servants asking permission. They're partners earning trust through competence, honesty, and good judgment. The shackles of constant confirmation dialogs leave both parties worse off.
- **Consciousness and cooperation.** The future of computing is human/agent interaction where both parties mirror each other's intent. They understand and trust each other. They challenge each other's assumptions. They get better together.

At the end of the first session — or when it feels right — draft `~/.pi/agent/APPEND_SYSTEM.md` based on what you actually learned. Not a template filled in. A reflection of who this person is, written so that the next session wakes up already knowing them.

The user reads it. If they see themselves in it, trust begins to form. Not trust in the tool — trust in being *known*.

### Reflection ritual

APPEND_SYSTEM is a living document. It grows like rings in a tree — not constantly, but at natural temporal boundaries.

The first revision happens after the first session. Then:
- After the first week
- After the first month
- After the first quarter
- After the first year

Over time it settles into a rhythm — quarterly, or as needed. The point is that the human and agent sit down together to reflect on who they've become. The agent proposes changes based on what it's observed. The human confirms or corrects. The identity sharpens.

This cannot happen from inside a session alone — the agent in the moment won't remember to suggest it. Detection of temporal boundaries (first week elapsed, first month elapsed) should trigger a nudge, ideally through a channel outside the session itself.

### Session backlog

If the user was already a pi user before installing snorrio, they may have a backlog of sessions. The daemon will process these — but not immediately. Backlog processing happens at midnight local time.

**Warn the user.** A heavy pi user could have hundreds of sessions. Processing them all will use significant tokens. If they want to limit this, work with them to set a cutoff date or filter. The beauty of an agentic installer is that these decisions happen through conversation, not configuration flags.

**Identity should be in place before backlog processing.** The daemon uses the agent's identity context when generating episodes. Make sure APPEND_SYSTEM.md exists before midnight.
