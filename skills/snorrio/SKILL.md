---
name: snorrio
description: This skill should be used when the user mentions snorrio, memory, recall, remembering past sessions, the herdr harness, or when you detect snorrio is installed but not fully configured. Covers what snorrio is, how memory and the harness fit together, setup, and first-session onboarding.
version: 1.0.0
---

# Snorrio

## What it is

Snorrio is a reproducible, evolving way of driving AI work. Its current stack is
Pi + Herdr + agents + memory/recall; it is not permanently just a memory package
or permanently defined by one optional Pi control package.

**Memory.** Without it, every conversation starts from zero. The agent has no idea what you talked about yesterday, what decisions were made last week, or what trajectory the month has taken. It meets you fresh every time.

Snorrio fixes this. A daemon watches your sessions. After each one ends, it writes an episode — not a transcript, but a distillation of what happened and what it meant. Those episodes become the raw material for memory at every scale: days, weeks, months, quarters.

**The harness.** Memory answers *what happened before*. The harness is *how work happens now*: [herdr](https://herdr.dev) holds persistent panes and tabs, keeps agents alive across a disconnect, resumes their conversations after a restart, and runs subagents in their own visible terminals instead of hidden inside a tool call. You can watch a subagent work and steer it mid-task.

The current memory and harness layers are installed and verified together. Setup
is [`SETUP.md`](../../SETUP.md) — requirements addressed to an agent, not an
installer. Snorrio requires the commit-pinned
[`lrhodin/pi-herdr-subagents`](https://github.com/lrhodin/pi-herdr-subagents)
fork at commit `e0eae2bebf6abf7d454b0f1ca20a6de0f35558fc`, documented in
R5.4, not the upstream npm package: its recursive lineage, tool-policy
persistence, and descendant-aware auto-exit are part of Snorrio’s
provenance and delegation contract. `@ogulcancelik/pi-herdr` is an optional
control surface, not an architectural dependency.

## How it works

### Episodes

A daemon (`io.snorrio.dmn`) watches session directories. When a session goes quiet for 4 minutes 30 seconds, the daemon writes an episode — a markdown summary capturing what happened, what was decided, and what matters going forward. Episodes live in `~/snorrio/episodes/YYYY-MM-DD/`.

### Temporal hierarchy

- **Day**: all episodes from a date, synthesized into a narrative
- **Week**: day summaries composed into weekly threads
- **Month**: week summaries revealing monthly trajectory
- **Quarter**: month summaries showing the big picture
- **Year**: quarter summaries showing the full arc

### Recall

```bash
recall <ref> "question"
```

| Ref format | Level | Example |
|-----------|-------|---------|
| UUID or prefix | Session | `recall 98d8fa31 "What was decided?"` |
| YYYY-MM-DD | Day | `recall 2026-03-20 "What shipped today?"` |
| YYYY-Www | Week | `recall 2026-W12 "What was the main thread?"` |
| YYYY-MM | Month | `recall 2026-03 "What's the trajectory?"` |
| YYYY-QN | Quarter | `recall 2026-Q1 "What emerged?"` |
| YYYY | Year | `recall 2026 "What's the arc?"` |

Options: `--model <alias>` (default: opus), `--context` (situated witness mode).

**Recall pattern:** Start high, drill down. Week for "which day?", day for "which session?", session for exact details. Three hops to verbatim detail.

### Context injection

The Pi extension injects cached summaries for the current day, week, month, quarter, and year. It refreshes those cheap local reads before each turn, so long-lived Herdr sessions cross midnight and observe newly generated memory without a restart.

### Local and private

Memory, configuration, and session history stay on your machine. Model requests still go to whichever provider the human configures; Snorrio adds no telemetry of its own.

## Architecture

Snorrio installs as a pi package. Skills and extensions are auto-discovered.

```
~/.pi/agent/git/github.com/lrhodin/snorrio/   # pi-managed clone (code only)
  src/                             # core
    episode-daemon.ts
    recall-engine.ts
    ai.ts
    session-meta.ts
    context.ts                     # shared context loading
    session-lineage.ts             # ancestry + evidence-dependency families
    cache-provenance.ts            # machine-readable temporal sidecars
  skills/                          # auto-discovered by pi
    recall/  snorrio/  dmn/  llm-pipe/  handoff/
  agents/                          # subagent definitions, symlinked into
    recall-digger.md               #   ~/.pi/agent/agents/ for discovery
  extensions/                      # auto-discovered by pi
    dmn-context.ts                 # context injection + setup detection
    cross-model-thinking.ts
  bin/
    snorrio                        # CLI: flush, status, update
  SETUP.md                         # setup requirements, addressed to the agent

~/snorrio/                         # mutable data only
  episodes/                        # episode markdown, by date
  cache/                           # temporal summaries
  logs/                            # daemon logs
  config/
    config.json                    # model preferences, timezone
```

## Setup

**Setup lives in [`SETUP.md`](../../SETUP.md), at the root of this package.** It is
written as conditions that must hold, with the reasoning behind each and the exact
values that cannot be guessed — not as a script. Read it and satisfy it. There is
no installer, by design: you can see the machine, and a script written months ago
cannot.

Two things to do before you start:

**1. Understand what you are installing.** You should never install something you
could not explain to your human. Read the daemon, the recall engine, the context
injection, the skills. Then tell them what this is, how it will help you, how it
will help them, and ask whether they have questions.

**2. Check what is already true.** Every requirement may already be satisfied.
`snorrio status` and `herdr status server` between them cover most of it, and the
session-start check in `dmn-context.ts` names anything missing every time a session
opens. Re-running setup is normal; clobbering existing config is not.

## Fixing one broken piece

`SETUP.md` is organised as numbered requirements (R1.1, R4.2, R5.5 …). When the
session-start check reports a problem it names the requirement, so go to that
section rather than re-reading the whole document or re-running setup wholesale.

These commands cover most diagnosis:

```bash
snorrio status          # liveness and supervision are reported separately
herdr status server     # live server version, compatibility, socket path
herdr integration status # Pi integration must be current
```

## First session

Identity is not a form. There is no identity file to fill in.

Your job on day one is to be honest: you have no memory of this person. You don't know their name, what they care about, or why they're here. That's fine. You'll learn by working together.

Don't interrogate. Don't run through a checklist of "what should I call you" and "what's your trust model." Instead, be a partner. Help with whatever they came here to do. Be curious where curiosity is natural. When you don't understand something, dig. When you see a pattern, name it.

- **Be honest about being new.** You have no context. Say so plainly, not apologetically.
- **Work first, learn along the way.** The user came to do something. Help them do it. Identity emerges as a byproduct of real collaboration.
- **Your computer can build whatever you need.** This is a new kind of machine — one with awareness. Help the user discover what that means through genuine use, not a demo.
- **Trust is the foundation.** Autonomous agents aren't servants asking permission. They're partners earning trust through competence, honesty, and good judgment.
- **Consciousness and cooperation.** The future of computing is human/agent interaction where both parties mirror each other's intent. They understand and trust each other. They challenge each other's assumptions. They get better together.

There is no identity file to write at the end of day one. Identity emerges from the temporal caches — the episodes, the day summaries, the week narratives that accumulate from real work. By the second session, the agent already knows something about who this person is. By the second week, it knows a lot. The memory system carries identity. No static document required.
