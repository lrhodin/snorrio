---
name: recall
description: Query past sessions and temporal summaries by reviving them with full context.
---
# Recall

Query past sessions and temporal summaries. Recall revives past context and answers questions from first-person experience.

## Before you recall

**Check your context first.** Your system prompt already contains temporal caches — today, this week, this month, this quarter, this year. Read them before calling any tool. The answer, or at least the right starting point, is often already in your context. Grep and recall are expensive; attention is free.

When recall IS needed, use your temporal context to pick the right entry point. Don't guess dates — your caches tell you which week or month a thread lived in.

## Prefer the `recall-digger` subagent

**Default to delegating.** Drilling the hierarchy costs many hops, and every
intermediate answer — dead ends, "which week was it", partial hits — lands in
whatever context window runs it. That noise is the whole cost of recall, and it
doesn't belong in the orchestrator's context.

```
subagent({ name: "Dig", agent: "recall-digger",
           task: "Find X. Report the exact <path/command/decision>." })
```

The digger runs the fan-out below in its own context and returns just the answer
plus a confidence line. A run that makes fifteen `recall` calls comes back as
twelve lines.

Run it inline yourself only when the answer is **one hop away** — a known day or
session id, single question, no searching. Anything requiring "which period was
this in?" should be delegated.

**Resume the digger for follow-ups — don't spawn a fresh one.** Every completion
message carries a `sessionPath`; pass it to `subagent_resume` with a `message`.
The original agent still holds the map: which levels it already searched, which
returned nothing, the query shapes that worked, and the pitfalls it hit. A new
agent re-derives all of it and can repeat a subtle mistake the first one already
found and fixed.

```
subagent_resume({ sessionPath: "<path from the completion message>",
                  message: "Follow-up: ..." })
```

`auto-exit: true` does not prevent this — it ends the session, but the transcript
persists and is the resume target. A digger can also call `caller_ping` to ask
you a clarifying question mid-dig: it exits, you get notified, and you resume it
with the answer rather than letting it guess.

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

### Fan out across siblings, then drill only the hits

Walking a single path down misses anything that lived on a neighbouring branch —
and you can't tell the difference between "it didn't happen" and "it happened in
the month I skipped". So at each level, ask **every sibling** a locating
question, **in parallel**, then descend only into the ones that answer yes.

```
MONTHS   ask 2026-06, 2026-07, 2026-08 concurrently:
         "Which week(s) involved X? Name them. If none, say none."
         → 06: no data · 07: none · 08: W33

WEEKS    drill W33 only: "Which day and which session?"
         → 08-10, session 019feca6

SESSION  extract: "Reproduce the exact token path and command."
```

Run siblings concurrently (background them in one bash call, or issue several
bash calls in a single tool block). Each hop is an LLM call; serializing them
burns wall-clock for nothing.

### Picking the entry level

No mandated starting point — choose the cheapest level that *certainly contains*
the answer:

| What you know | Start at |
|---|---|
| Exact date | that **day** |
| "last week", "a few days ago" | **week** |
| "sometime last month", "when did we set up X" | **month** fan-out |
| No idea, or possibly long ago | **quarter** / **year** fan-out |

Month-level fan-out is the usual sweet spot: few enough siblings to run at once,
specific enough that answers name real weeks. When torn, start one level *above*
your guess — a wasted locating hop costs ~2s, while starting too low makes you
conclude something never happened.

### Writing locating questions

The fan-out is only as good as the question:

- **Enumerate and name** — "Which week(s) involved X? Name the specific weeks."
  Not "tell me about X."
- **Always add "If none, say none."** Without an explicit null option, levels
  reach for marginal relevance and every sibling looks like a hit.
- **Disambiguate the thing you actually want.** Ask about "an API token being
  created or used", not "auth work". A topic can be *discussed* constantly and
  *administered* never — that gap is the most common source of false hits.
- **Ask for the pointer** — "name the day and session id" — so the next hop is
  immediate.

At the bottom, switch from locating to extracting: "reproduce the exact command",
"quote it verbatim", "what was the file path".

### Trust and corroboration

Recall reconstructs from summaries and **can be confidently wrong about
specifics**. When the answer is a path, command, credential, ID, or number you're
about to act on, verify it against the filesystem before relying on it, and keep
the two claims separate: what was recalled vs what you confirmed. A remembered
credential path that no longer works is worse than no answer.

`[recall: no data found for X]` is a legitimate finding — that period has no
recorded sessions, often because history starts later than assumed. Report it
rather than routing around it.

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

## Time travel (`--at`)

```bash
recall --at <ISO-timestamp> <ref> "question"
recall --at 2026-06-01T00:00:00Z 2026-W22 "What did this week's summary say at the time?"
```

Reads the caches **as they stood at that wall-clock moment**, via the data
repo's git history — the faithful past-self view, free of later hindsight.

- Works for **week/month/quarter/year refs only.** Day and session refs read
  episodes/raw sessions directly (not versioned caches) and are rejected with
  a clear error — don't retry, drill at the week level instead.
- A cache that didn't exist at that time is **skipped, never regenerated**.
  Nothing is written in `--at` mode.
- Timestamps before the data repo's first commit return a clear
  "history starts later" error.

## Timeout

Recall invokes an LLM under the hood. **Always use a minimum 120-second timeout** (or omit timeout entirely). If you set it too short and it aborts, you lose all the work and have to re-run.

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
