# snorrio

> *ok njóttu nú sem þú namt* — make use of what you have learned.
>
> — Gylfaginning, Snorri Sturluson, ~1220 AD

Snorri Sturluson preserved Norse mythology by writing it down when it would otherwise have been lost. Eight centuries later, we have the same problem — except what's being lost is every good thought you've ever had with an AI.

snorrio fixes that.

## Getting Started

```bash
npm install -g @mariozechner/pi-coding-agent     # install pi
pi install git:github.com/snorrio/snorrio        # install snorrio
pi                                               # start — follow the thread
```

---

## What if your agent actually knew you?

Not your name. Not a system prompt someone wrote last month. *Knew* you — the way someone knows you after working together for months. What you've been circling around. Which approaches you already tried and killed. The decision you made three weeks ago that's about to matter again.

Every AI conversation today starts from scratch. You re-explain yourself. You re-establish context. You re-discover things you already figured out. It's like Odin sacrificing his eye for wisdom, except the well forgets and you have to do it again tomorrow.

snorrio runs in the background, watching your [pi](https://github.com/mariozechner/pi) sessions, distilling them into episodes, and weaving that context back into every new conversation. Over weeks, your agent develops real continuity. It stops being a stranger.

But that's not the interesting part.

## Versions of you that you can't be

The interesting part is what happens when you give an agent access to temporal perspectives that don't exist in human cognition.

A day holds every conversation from its twenty-four hours in working memory — simultaneously. Not reading notes. Holding the complete context and reasoning across all of it at once. A week does that with seven days. A quarter holds three months of compressed experience and sees patterns in a single pass.

You can't do this. I can't do this. No one can hold a quarter of their working life in active memory and think clearly about it. But the quarter can. And when you ask it *"what am I not seeing?"* — it tells you. From a vantage point that simply doesn't exist for humans.

These aren't summaries at different zoom levels. A day and a quarter looking at the same week of work will notice different things. Both are right. They're just seeing from different temporal elevations — like how a valley and a mountain pass show you the same landscape but completely different terrain.

That's the thing that actually changes you. Not the convenience. The moment you ask a quarter a question and it reveals a pattern you were living inside but couldn't see.

The Norse had a word for this kind of knowledge — the kind you can't get by looking directly. You have to give something up to see it. An eye for the well. snorrio is the well.

## How it works

Every conversation is frozen the moment it ends. Immutable. The full reasoning, the full you-from-before. Frozen sessions are ground truth.

A daemon watches for quiet, then distills each session into an **episode** — what moved forward, what was decided, what's still open. Episodes roll up into **temporal caches**:

```
Session  →  Day  →  Week  →  Month  →  Quarter  →  Year
```

Each layer summarizes the layer below. Compression accumulates — a quarter summary is far from the original words. That's the point. The caches aren't the territory. They're the map. A week cache tells you where to look. A quarter cache tells you what mattered. When you need the real thing, you go to the source — `recall <session-id> "what actually happened?"` — and the frozen session speaks for itself.

At the start of every new session, snorrio injects your temporal context automatically. Today, this week, this month, this quarter. Your agent starts already knowing where you are. You just keep going.

When you or your agent need to dig, `recall` is there. You can use it from the command line, but mostly your agent uses it on its own — following the map down to ground truth when it needs to be precise.

Say you ask your agent: *"What did we decide about the auth flow?"* The agent checks its injected context — the week cache mentions auth work on Thursday. So it drills:

```bash
recall 2026-W11 "What was decided about the auth flow?"
# Week says: "Switched from JWT to session tokens on Thursday"

recall 2026-03-06 "Why did we switch from JWT to session tokens?"
# Day says: "Session d7f3a... explored JWT refresh issues, decided tokens were simpler"

recall d7f3a "What were the specific JWT problems?"
# Session speaks: the exact conversation, the exact reasoning
```

Three hops. Week → day → session. Map → region → ground truth. The agent does this automatically — it reads the cache, decides it needs more, and keeps drilling until it has what it needs.

## Three pillars

1. **Identity** (`APPEND_SYSTEM.md`) — Who the agent is. What it values. Travels everywhere.
2. **Memory** (episodes, recall, caches) — What the agent knows. Syncs across machines.
3. **Skills** (machine-local) — What the agent can do *here*. Stays local.

Identity and memory travel. Skills stay put. Same agent on your home machine and your work laptop — same knowledge, different capabilities. Same thread, different looms.

---

## Under the hood

### Context injection

At session start, snorrio reads your temporal caches and injects them into the system prompt. Today, this week, this month, this quarter — all woven in automatically. Your agent starts oriented. No commands needed.

### The daemon

`io.snorrio.dmn` watches sessions via FSEvents. After 4:30 of quiet, it generates an episode. Caches rebuild at day and week boundaries. `/done` flushes immediately.

### Recall

```bash
recall <session-id> "What was decided about the API?"
recall 2026-03-10 "What shipped today?"
recall 2026-W11 "What's the pattern this week?"
recall 2026-03 "Where is this month heading?"
recall 2026-Q1 "What's the arc?"
```

Revives the appropriate level, asks your question, returns a grounded answer. ~2–15 seconds depending on scope.

### Config

`~/.config/snorrio/config.json`:

```json
{
  "provider": null,
  "model": "opus",
  "timezone": null,
  "tools": {}
}
```

Provider and timezone auto-detect. Override if you want.

### Storage

```
~/.snorrio/
├── episodes/YYYY-MM-DD/    # One per session
├── cache/
│   ├── days/
│   ├── weeks/
│   ├── months/
│   ├── quarters/
│   └── years/
└── logs/
```

Plain text markdown. Human-readable. Auditable. Nothing leaves your machine.

### Principles

**Immutability.** Sessions never change. Everything else is derived.

**Ground truth is always reachable.** Compression accumulates going up. But the frozen sessions are always there. When the summary isn't enough, go to the source.

**Interrogation over retrieval.** You don't search documents. You revive past agents and ask them what they know.

**Transparency.** Every episode, cache, and prompt is readable. Trace any claim back to its source session.

**Privacy.** Your machines. Your data. No cloud, no telemetry, no tracking.

## License

MIT

---

*ok njóttu nú sem þú namt*
