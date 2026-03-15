---
name: subagent
description: Spawn pi subagents in tmux for tasks that benefit from isolation — research, exploration, builds, or parallel work. Keeps your context clean.
---

# Subagents

Spawn pi agents in tmux using the `subagent` CLI. Each subagent is a full pi session with the same skills and tools you have, including this one.

Use subagents for anything that would consume a lot of your context — research, codebase exploration, builds, parallel tasks. Even a single subagent is useful.

## Setup

Before first use, check if everything is in place. Run through this list — skip anything already done.

#### 1. tmux

```bash
which tmux || brew install tmux
```

#### 2. CLI symlink

Resolve this skill's directory to find the package root (this file is at `skills/subagent/SKILL.md` — the package root is two levels up). Use that as `PACKAGE_DIR`.

```bash
chmod +x PACKAGE_DIR/skills/subagent/subagent.mjs
ln -sf PACKAGE_DIR/skills/subagent/subagent.mjs ~/.local/bin/subagent
```

Make sure `~/.local/bin` is on PATH (the snorrio setup checklist handles this — if not done yet, load the **snorrio** skill).

#### 3. Verify

```bash
which subagent && subagent list
```

If `subagent list` runs without error, you're set. The signal extension (`subagent-signal.ts`) is in the package's extensions directory and is loaded automatically by pi.

## CLI

```
subagent spawn <workspace-dir> <name> [name...]    # spawn named agents from prompts/<name>.md
subagent spawn <name> <prompt-file> [-c <dir>]     # spawn a single agent
subagent status [workspace-dir]                    # show what agents are doing
subagent wait <workspace-dir>                      # block until all complete
subagent wait <prefix>                             # block until all matching prefix complete
subagent wait <name> [name...]                     # block until named agents complete
subagent logs <name>                               # last 500 lines from pane
subagent send <name> <message>                     # steer a running agent
subagent kill <workspace-dir>                      # tear down all workspace agents
subagent kill <name> [name...]                     # tear down named agents
subagent list                                      # show all active sessions
```

## How it works

### Workspace convention

```
~/agents/my-op/
  AGENTS.md        # shared context — pi picks this up automatically
  prompts/         # one .md per agent (task-specific)
  output/          # agents write results here
```

`AGENTS.md` in the workspace root is picked up by every agent spawned there. Put shared context, conventions, and constraints here. Keep individual prompts focused on the specific task.

Session names: `<dirname>-<name>` (e.g., `my-op-topic-a` for workspace `~/agents/my-op/` with prompt `topic-a.md`).

### Completion signaling

Automatic — no manual signaling needed:
- **Normal completion:** extension signals `done-<name>` when the agent finishes.
- **Crash/unexpected exit:** signals `failed-<name>` automatically.

An agent can explicitly signal failure:
```bash
touch /tmp/subagent-signaled-<name> && tmux wait-for -S "failed-<name>"
```

`subagent wait` listens for both done and failed signals, prints results with timing, and exits with code 1 if any agent failed.

### Multi-phase operations

Kill completed sessions between phases. Otherwise `subagent wait` finds stale Phase 1 sessions and hangs.

```bash
# Phase 1
subagent spawn ~/agents/my-op scout-a scout-b scout-c
subagent wait ~/agents/my-op
subagent kill ~/agents/my-op

# Phase 2
subagent spawn ~/agents/my-op specialist-a specialist-b
subagent wait ~/agents/my-op
```

Or use explicit names: `subagent wait specialist-a specialist-b`.

## Writing prompts

Subagents have the same skills and tools you do. Don't over-explain how to use them — just describe the task.

Include a contract: what to deliver, where to write it, what "done" means.

Tell agents to stop and report problems rather than working around them. `"My web-search tool is broken"` is more useful than a partial report pulled from training data.

## Example

```bash
mkdir -p ~/agents/research/prompts ~/agents/research/output

cat > ~/agents/research/AGENTS.md << 'EOF'
You are a research subagent. Write output to ~/agents/research/output/<your-name>.md.
Search first. Don't write from training data.
On tool errors: STOP and report what broke. Don't work around it.
EOF

cat > ~/agents/research/prompts/topic-a.md << 'EOF'
Research topic A in depth. Write findings to output/topic-a.md.
EOF

cat > ~/agents/research/prompts/topic-b.md << 'EOF'
Research topic B in depth. Write findings to output/topic-b.md.
EOF

subagent spawn ~/agents/research topic-a topic-b
subagent wait ~/agents/research
# Read output/topic-a.md and output/topic-b.md, then synthesize
subagent kill ~/agents/research
```

## Watching agents work

The spawn command outputs the tmux attach command. To watch an agent in real time:

```bash
tmux attach -t <session-name>
```

Detach with `Ctrl-b d`. The agent keeps running.
