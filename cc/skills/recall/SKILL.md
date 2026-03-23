---
name: recall
description: This skill should be used when you need to remember past sessions, look up what happened on a specific day/week/month, or answer questions that require historical context. Use it to drill into past conversations, find specific decisions, commands, or discussions.
version: 1.0.0
---

# Recall

```bash
recall <ref> "question"
```

| Ref format | Level | Example |
|-----------|-------|---------|
| UUID or prefix | Session | `recall 98d8fa31 "What was decided about the architecture?"` |
| YYYY-MM-DD | Day | `recall 2026-03-20 "What shipped today?"` |
| YYYY-Www | Week | `recall 2026-W12 "What was the main thread?"` |
| YYYY-MM | Month | `recall 2026-03 "What's the trajectory?"` |
| YYYY-QN | Quarter | `recall 2026-Q1 "What emerged this quarter?"` |

Options: `--model <alias>` (default: opus), `--context` (situated witness mode).

Start at the right level. Week for "which day?", day for "which session?", session for exact details. Three hops to verbatim detail.

If recall isn't working, read the snorrio skill (`/snorrio`) for setup instructions.
