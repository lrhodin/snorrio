---
description: Query past sessions and temporal summaries by reviving them with full context.
---
# Recall

Query past sessions and temporal summaries. Recall revives past context and answers questions from first-person experience.

## CLI usage

```bash
recall <ref> "question"
recall 2026-03-05 "What shipped today?"
recall 2026-W10 "What was the main thread?"
recall 2026-03 "What's the trajectory of this month?"
recall 2026-Q1 "What emerged this quarter?"
recall 50690a64 "What beeper commands did you run?"
```

## Reference types

| Format | Level | Context loaded |
|--------|-------|---------------|
| `YYYY-MM-DD` | Day | All episodes for that day |
| `YYYY-Www` | Week | Cached day summaries |
| `YYYY-MM` | Month | Cached week summaries |
| `YYYY-QN` | Quarter | Cached month summaries |
| UUID prefix | Session | Full session transcript |

## Navigation pattern

Start broad, drill down:

1. `recall 2026-W10 "which day had the browser automation work?"` → "March 6th"
2. `recall 2026-03-06 "which session set up CDP?"` → "session 50690a64"
3. `recall 50690a64 "what was the exact Chrome launch command?"` → verbatim detail

Each hop takes ~1-2s. Three hops to exact detail in under 5 seconds.

## As a tool

The `recall` tool is available in pi sessions via the recall-tool extension. Use it for:
- Looking up past decisions
- Finding exact commands or configurations
- Checking what was discussed on a specific day
- Cross-referencing across time periods

## Model selection

Default model: haiku (fast, ~1s). Override with `--model`:
```bash
recall --model opus 2026-Q1 "quarterly reflection"
```

## Data location

- Episodes: `$SNORRIO_HOME/episodes/` (default `~/.snorrio/episodes/`)
- Caches: `$SNORRIO_HOME/cache/` (default `~/.snorrio/cache/`)
