---
name: recall
description: This skill should be used when you need to remember past sessions, look up what happened on a specific day/week/month, or answer questions that require historical context. Use it to drill into past conversations, find specific decisions, commands, or discussions.
version: 1.0.0
---

# Recall — Query Past Sessions and Temporal Summaries

## Usage

```bash
recall <ref> "question"
```

### Reference types

| Ref format | Level | Example |
|-----------|-------|---------|
| UUID or prefix | Session | `recall 98d8fa31 "What was decided about the architecture?"` |
| YYYY-MM-DD | Day | `recall 2026-03-20 "What shipped today?"` |
| YYYY-Www | Week | `recall 2026-W12 "What was the main thread?"` |
| YYYY-MM | Month | `recall 2026-03 "What's the trajectory?"` |
| YYYY-QN | Quarter | `recall 2026-Q1 "What emerged this quarter?"` |

### Options

- `--model <model>` — Model to use (default: opus). Aliases: haiku, sonnet, opus.
- `--context` — Load temporal context from when the session ran (situated witness mode).

### Recall pattern

Start at the right level. Week for "which day?", day for "which session?", session for exact details. Three hops to verbatim detail.

## Setup

The recall CLI is at `~/.snorrio/bin/recall` (symlinked at install). If it's not on your PATH, run it directly:

```bash
node /path/to/snorrio/src/recall-engine.ts <ref> "question"
```

### Hook setup

For automatic context injection at session start, add to `~/.claude/settings.json`:

```json
{
  "hooks": {
    "SessionStart": [
      {
        "matcher": "",
        "hooks": [
          {
            "type": "command",
            "command": "node /path/to/snorrio/cc/session-start.mjs"
          }
        ]
      }
    ]
  }
}
```

Replace `/path/to/snorrio` with the actual path where snorrio is installed (check `~/.snorrio` or the git clone location).

### Daemon

The episode daemon (`io.snorrio.dmn`) must be running to generate episodes from sessions. Check with:

```bash
launchctl list | grep snorrio
```

If not running, the recall CLI will still work for temporal queries (day/week/month/quarter) if cached summaries exist, but session-level recall requires episodes to be generated first.
