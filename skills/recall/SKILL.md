---
name: recall
description: Query past sessions and temporal summaries by reviving them with full context.
---
# Recall

Query past sessions and temporal summaries. Recall revives past context and answers questions from first-person experience.

## Invocation

`recall` is on PATH (`~/.local/bin/recall`). Always use it directly — never run the source file.

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

**Always drill down through layers. Never skip levels.**

Each level only knows about its direct subordinates — a quarter knows months, a month knows weeks, a week knows days, a day knows sessions. Asking a quarter for a specific session ID will fail. Ask it which *month*, then ask the month which *week*, then drill further.

1. `recall 2026-W10 "which day had the browser automation work?"` → "March 6th"
2. `recall 2026-03-06 "which session set up CDP?"` → "session 50690a64"
3. `recall 50690a64 "what was the exact Chrome launch command?"` → verbatim detail

Each hop takes ~1-2s. Three hops to exact detail in under 5 seconds.

**Wrong:** `recall 2026-Q1 "what are the top 5 philosophical sessions?"` — the quarter doesn't have session-level detail.
**Right:** `recall 2026-Q1 "which months had deep philosophical work?"` → drill to week → drill to day → get session IDs.

## Model selection

Default model: opus. Override with `--model`:
```bash
recall --model sonnet 2026-W12 "quick summary"
```

## Flushing pending sessions

If you need episodes from the current or recent sessions processed before recalling:
```bash
snorrio flush
```

## Data location

- Episodes: `~/snorrio/episodes/`
- Caches: `~/snorrio/cache/`
