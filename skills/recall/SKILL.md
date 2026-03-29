---
name: recall
description: Query past sessions and temporal summaries by reviving them with full context.
---
# Recall

Query past sessions and temporal summaries. Recall revives past context and answers questions from first-person experience.

## When to use recall

If it happened in a past session and isn't saved as a file, recall is how you find it. Start at the temporal level that covers the time range and drill down.

## Invocation

`recall` is on PATH (`~/.local/bin/recall`). Always use it directly — never run the source file.

```bash
recall <ref> "question"
recall 2026-03-05 "What shipped today?"
recall 2026-W10 "What was the main thread?"
recall 2026-03 "What's the trajectory of this month?"
recall 2026-Q1 "What emerged this quarter?"
recall 2026 "What's the arc of this year?"
recall 50690a64 "What beeper commands did you run?"
```

## Reference types

| Format | Level | Context loaded |
|--------|-------|---------------|
| `YYYY-MM-DD` | Day | All episodes for that day |
| `YYYY-Www` | Week | Cached day summaries |
| `YYYY-MM` | Month | Cached week summaries |
| `YYYY-QN` | Quarter | Cached month summaries |
| `YYYY` | Year | Cached quarter summaries |
| UUID prefix | Session | Full session transcript |

## Navigation pattern

**Always drill down through layers.** Each level only knows about its direct subordinates — a year knows quarters, a quarter knows months, a month knows weeks, a week knows days, a day knows sessions.

At each level, ask a **locating question** — "which day," "which session" — to find where something lives. The content lives at the bottom. Every hop above that is navigation.

### Example: finding a letter someone sent you last week

```
recall 2026-W13 "Which day did I receive the letter?"
→ "March 23rd, in session 45e74acf"

recall 2026-03-23 "Which session had the letter?"
→ "Session 45e74acf"

recall 45e74acf "Reproduce the full text of the letter."
→ [verbatim content]
```

Three hops. Each one narrows: week → day → session → content.

### Example: finding a specific command from a past session

```
recall 2026-W10 "Which day had the browser automation work?"
→ "March 6th"

recall 2026-03-06 "Which session set up CDP?"
→ "session 50690a64"

recall 50690a64 "What was the exact Chrome launch command?"
→ [verbatim detail]
```

Each hop takes ~1-2s. Three hops to exact detail in under 5 seconds.

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
