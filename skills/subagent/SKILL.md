---
name: subagent
description: Spawn pi subagents in tmux for tasks that benefit from isolation — research, exploration, builds, or parallel work. Keeps your context clean.
---

# Subagents

Spawn pi agents in tmux using the `subagent` CLI. Each subagent is a full pi session with the same skills and tools you have, including this one.

Use subagents for anything that would consume a lot of your context — research, codebase exploration, builds, parallel tasks. Even a single subagent is useful.

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

## Workspace convention

```
~/agents/my-op/
  AGENTS.md        # shared context — pi picks this up automatically
  prompts/         # one .md per agent (task-specific)
  output/          # agents write results here
```

`AGENTS.md` in the workspace root is picked up by every agent spawned there. Put shared context, conventions, and constraints here. Keep individual prompts focused on the specific task.

Session names: `<dirname>-<name>` (e.g., `my-op-topic-a` for workspace `~/agents/my-op/` with prompt `topic-a.md`).

## Failure signaling

Completion signaling is automatic:
- **Normal completion:** extension signals `done-<name>` when the agent finishes.
- **Crash/unexpected exit:** signals `failed-<name>` automatically.

An agent can explicitly signal failure by touching a marker file and sending the signal:
```bash
touch /tmp/subagent-signaled-<name> && tmux wait-for -S "failed-<name>"
```

`subagent wait` listens for both done and failed signals, prints results with timing, and exits with code 1 if any agent failed.

## Multi-phase operations

When running phases (e.g., scouts then specialists), kill completed sessions between phases. Otherwise `subagent wait <workspace>` will find stale Phase 1 sessions and hang waiting for already-consumed signals.

```bash
# Phase 1
subagent spawn ~/agents/my-op scout-a scout-b scout-c
subagent wait ~/agents/my-op
subagent kill ~/agents/my-op    # clean up before Phase 2

# Phase 2
subagent spawn ~/agents/my-op specialist-a specialist-b
subagent wait ~/agents/my-op
```

Alternatively, use explicit names instead of prefix-based wait: `subagent wait specialist-a specialist-b`.

## Example

```bash
mkdir -p ~/agents/my-op/prompts ~/agents/my-op/output

# Shared context for all agents
cat > ~/agents/my-op/AGENTS.md << 'EOF'
You are a research subagent. Write output to ~/agents/my-op/output/<your-name>.md.
Search first. Don't write from training data.
On tool errors: STOP and report what broke. Don't work around it.
EOF

# Individual task prompts
cat > ~/agents/my-op/prompts/topic-a.md << 'EOF'
Research topic A in depth.
EOF

cat > ~/agents/my-op/prompts/topic-b.md << 'EOF'
Research topic B in depth.
EOF

# Spawn specific agents (not all prompts in the dir)
subagent spawn ~/agents/my-op topic-a topic-b
subagent status ~/agents/my-op
subagent wait ~/agents/my-op
subagent kill ~/agents/my-op
```

## Attach command

After spawning subagents, always print the tmux attach command so Ludvig can watch them:

```
To watch: tmux attach -t <session-name>
```

For multiple agents, print one attach command per agent.

## Prompts

Subagents have the same skills and tools you do. You don't need to explain how to use them — just describe the task.

Include a contract: what to deliver, where to write it, what "done" means.

Tell agents to stop and report problems rather than working around them. `"My web-search tool is broken"` is more useful than a partial report pulled from training data.

## Installation

The subagent CLI and signal extension are part of the snorrio package.

**CLI** — symlink to PATH during setup:

```bash
chmod +x PACKAGE_DIR/skills/subagent/subagent.mjs
ln -sf PACKAGE_DIR/skills/subagent/subagent.mjs ~/.local/bin/subagent
```

**Signal extension** — automatically loaded by pi from the package's extensions directory.

**Dependency**: `tmux` must be installed (`brew install tmux`).
