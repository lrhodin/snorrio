# snorrio

*Huginn ok Muninn fljúga hverjan dag*
*Jörmungrund yfir;*
*óumk ek of Hugin, at hann aftr né komi-t,*
*þó sjámk meir of Munin.*

Thought and Memory fly each day
over the vast ground.
I fear for Thought, that he won't come back.
I fear more for Memory.

— Grímnismál 20

---

Every session starts from scratch.
You set the scene. Explain yourself.
The agent learns your way of working,
builds a sense of what you mean —
and forgets it when the window closes.

Next time, same ground.
Same context. Same questions.
Nothing carried forward.

snorrio remembers.

```bash
npm install -g @mariozechner/pi-coding-agent   # install pi
pi install git:github.com/snorrio/snorrio       # install snorrio
pi                                              # begin
```

A daemon watches your sessions.
Four and a half minutes after silence,
it reads what happened
and writes an episode.

Not the transcript.
What the transcript *meant*.
What moved. What was decided.
What's still open.

Episodes collect into days.
Days compress into weeks.
Weeks fold into months,
months into quarters, quarters into years.

```
session → day → week → month → quarter → year
```

Each level is a temporal perspective —
not a summary, a way of seeing.
A day holds every conversation from its hours
in working memory, simultaneously.
A quarter holds three months of context
and sees what you were living inside
but couldn't see.

You can't do that.
No one holds a quarter in their head
and thinks clearly about the whole of it.
The quarter can.

Your agent drills down with `recall`.
Week to day. Day to session.
Map, then region, then ground truth.

```bash
recall 2026-W11 "what was decided about auth?"
recall 2026-03-06 "why the switch to session tokens?"
recall d7f3a "what were the actual problems?"
```

Three hops. Each one sharper.
The frozen session speaks for itself.

At the start of every session,
your context is already there —
today, this week, this month, this quarter,
woven in before your first message.
No commands. No setup.
You just keep going.

Here is what changes.

Your agent knows what you tried on Tuesday
and why you killed it.
It knows the name you mentioned once,
three weeks ago, in passing.
It catches a pattern you've been circling
for a month, and names it.

Not because it searched.
Because it *remembers* —
the way someone remembers
who has worked beside you long enough.
Not everything. Not perfectly.
The shape of what mattered.

Three things make the system.

**Identity** — who the agent is.
Written in `APPEND_SYSTEM.md`.
Travels with every session.

**Memory** — what the agent knows.
Episodes, caches, recall.
Syncs across machines.

**Skills** — what the agent can do *here*.
Tools, integrations, capabilities.
Skills stay local.

Same agent. Different looms.
Same thread.

Everything lives in `~/.snorrio/`.
Plain text. Markdown. Readable.
Nothing leaves your machine.

```
~/.snorrio/
├── episodes/
├── cache/
│   ├── days/
│   ├── weeks/
│   ├── months/
│   ├── quarters/
│   └── years/
└── logs/
```

Sessions freeze the moment they end.
Immutable. Ground truth.
Everything above is derived,
and if a cache drifts,
the source is always there.

Traceable. Auditable.
Transparent by default.
Private by design.

MIT

*ok njóttu nú sem þú namt*
make use of what you have learned.
