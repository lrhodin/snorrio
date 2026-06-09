# Interest Caches — technical spec

**Status:** draft / design. Not yet implemented.
**Author:** Ludvig + Colter, 2026-06-06.
**Supersedes nothing.** Builds on TODO items "Manual ritual layer", "recall: faithful past-selves", and "PRM".

---

## 1. Problem

snorrio keeps **exactly one cache per temporal layer** (`cache/{days,weeks,months,quarters,years}/<ref>.md`). That single file is a codec with one fixed bitrate that must serve every future query equally, so it averages — it can't be sharp for the musical lens or the technical lens because it had to leave room for both. A whole person (Ludvig) collapses into one narrative per layer.

Two distinct upgrades, deliberately kept separate because they have very different costs:

- **Partition** — materialize *N* caches per layer along an **interest taxonomy** (a graph: ~5 top-level interests, each with sub-interests). The taxonomy is a *versioned artifact* that advances in discrete commits; every cache is pinned to the taxonomy version it was built under.
- **Projection** — choose a **lens** at read time. The same session summarized *musically* surfaces the wav file; summarized *technically* surfaces the exact prompt-audio steps that worked that night. This needs **no new storage** — `recall()` already runs an LLM over the underlying episodes, so a lens is just a prompt clause.

A third, load-bearing concern threads through both: **versioning is now a prerequisite, not a nice-to-have.** Going from 1 to N caches per layer multiplies the existing "regenerate-with-hindsight" contamination N-fold. We fix that first.

### Non-goals (v1)
- Vector/embedding search (separate TODO; complementary, not a replacement).
- Materializing per-lens caches on disk (projection stays read-time in v1).
- Inter-person memory sync, PRM people-graph (the infra here should *accommodate* a second taxonomy, but PRM is out of scope).

---

## 2. Current architecture (ground truth)

Verified against the repo and live `~/snorrio` on 2026-06-06. Key facts that constrain the design:

| Concern | Current reality | File / symbol |
|---|---|---|
| Episodes | `~/snorrio/episodes/YYYY-MM-DD/<session-uuid>.md`, YAML frontmatter (`origin/machine/source/timestamp`) + LLM prose. ~2307 files. | `episode-daemon.ts:buildFrontmatter`, `generateEpisode` |
| Caches | `~/snorrio/cache/<dir>/<ref>.md`, **bare prose, no frontmatter**, one per (layer, ref). | `episode-daemon.ts:rebuildCache` |
| Layers | 5, **hardcoded and duplicated** in 4 files. No registry. | `cascade-decision.ts:CASCADE_ORDER`, `episode-daemon.ts`, `context.ts`, `recall-engine.ts` |
| Generation chokepoint | A cache is the verbatim output of `recall(ref, CACHE_Q_<level>, null)`. | `episode-daemon.ts:rebuildCache` → `recall-engine.ts:recall` |
| Cascade | Every live episode **unconditionally** rebuilds day→week→month→quarter→year, each level reading the *current* (just-regenerated) child caches. | `cascade-decision.ts:decideCascade`, `episode-daemon.ts:batchCascade` |
| Passive injection | `loadContext()` reads one cache per layer, no LLM, ~12K tokens, **no budget**, injected every session. | `context.ts:loadContext`, `extensions/dmn-context.ts` (`before_agent_start`) |
| On-demand read | `recall <ref> "q"` — single-level, recursive-downward, LLM-in-loop, streaming. | `recall-engine.ts:recall`, `refType` |
| Tags / index / db | **None.** "No manifest. No state tracking." Filesystem is the database. | `episode-daemon.ts:8` |
| Versioning | **None.** `~/snorrio` is *not* a git repo. `atomicWrite` overwrites in place; history is lost each cascade. | `atomic-write.ts` |
| Poison guard | Cache writes are guarded against caching `[recall: …]` error sentinels. **Any new write path must replicate this.** | `cache-guard.test.ts`; guard `summary && !summary.startsWith("[recall:")` |
| Config | Near-empty: `{machine, timezone}`. Everything else hardcoded. | `~/snorrio/config/config.json` |
| Validation gate | `npm run typecheck && npm test`; `.githooks/pre-commit` enforces on `src/extensions/skills/tests` changes. | `package.json`, `.githooks/` |

Three funnels every change must thread:
- **write/build:** `episode-daemon.ts` (`rebuildCache`, `cascadeForDate`, `validateCaches`)
- **read/inject:** `context.ts:loadContext` (+ `extensions/dmn-context.ts`)
- **query:** `recall-engine.ts` (`refType` + the `recall*` family)

---

## 3. Design

### 3.1 The taxonomy artifact

A single versioned file: **`~/snorrio/taxonomy/taxonomy.json`**.

```jsonc
{
  "version": 7,                       // monotonic; bumped on every committed edit
  "updated": "2026-06-06T19:50:00Z",
  "spine": ["family", "work", "music", "system", "self"],  // active top-level, ≤ ~5
  "nodes": {
    "family":  { "parent": null,   "label": "Family",        "status": "active",
                 "keywords": ["Kat", "kids", "wife", "Sweden", "Tove"] },
    "family.kat": { "parent": "family", "label": "Kat", "status": "active", "keywords": ["Kat"] },
    "work":    { "parent": null,   "label": "Work / career", "status": "active",
                 "keywords": ["Aurora", "interview", "offer", "Cisco"] },
    "music":   { "parent": null,   "label": "Music / craft",  "status": "active",
                 "keywords": ["prompt-audio", "synth", "echorec", "monitor"] },
    "music.promptaudio": { "parent": "music", "label": "prompt.audio", "status": "active" },
    "system":  { "parent": null,   "label": "The system (snorrio/pi)", "status": "active" },
    "self":    { "parent": null,   "label": "Self / health",  "status": "active" },
    "jobsearch": { "parent": "work", "label": "Job search", "status": "dormant",
                   "retired": "2026-07-01", "keywords": ["Albert","Natera","Anduril"] }
  }
}
```

- **Spine** = the ≤5 top-level interests injected into context by default. Number drawn from span-of-control (≥5 starts getting tricky). Held loosely — some windows want 3, some 7. The cap matters more for *what's always in context* than for *what exists on disk*.
- **Nodes** form a graph by `parent`. Top level = spine; children = drill-on-demand (like skills). `status` ∈ `active | dormant`. Dormant nodes still own their historical caches but stop being regenerated and drop out of the spine. (`jobsearch` is the canonical example: owned Q2, evaporating now.)
- **`version`** is the pin. The data dir is git (§3.3), so `version` ≡ the commit that last touched this file; we keep an explicit integer too for human readability and frontmatter stamping.
- **Keywords** are weak priors for the tagger and the shift detector, not hard rules.

A sibling **`~/snorrio/taxonomy/CHANGELOG.md`** (append-only, plain English) records every edit — see §3.6.

### 3.2 Session tagging (multi-label, weighted)

The unit of compression is **(session × interest)**, not session-assigned-to-one-bin. A session feeds several interest caches with weights.

Extend episode frontmatter:

```yaml
---
origin: pi
machine: colter
source: ~/.pi/agent/sessions/--Users-ludvig-colter--/..._019e....jsonl
timestamp: 2026-06-07T02:48:54Z
taxonomy_version: 7
interests:
  - { id: work,  weight: 0.6 }
  - { id: family, weight: 0.2 }   # the Kat thread inside the Aurora memo
  - { id: self,  weight: 0.2 }
---
```

- Produced **inside episode generation** (the LLM already reads the whole session — one extra structured output, conditioned on the *current* taxonomy's active node list so labels come from a controlled vocabulary, not free invention). Weights ≈ sum to 1; a threshold (default `0.15`, config) decides cache membership.
- `taxonomy_version` stamps which vocabulary was used, so re-tags are detectable.
- **Backfill:** a `snorrio retag <range>` migration over ~2307 episodes, mirroring the existing `--add-frontmatter` precedent (`episode-daemon.ts:735`). Idempotent; skips episodes already at current `taxonomy_version`.

This is the **foundational missing piece** — nothing in the codebase tags sessions today, and neither selection nor partition can happen without it.

### 3.3 Versioning (the prerequisite — fixes the hindsight bug)

This lands **first** (Phase 0) and has standalone value independent of the rest.

1. **`git init ~/snorrio`** (the *data* dir, distinct from the source repo). `cache/`, `episodes/`, `taxonomy/` become tracked. (Note: the source repo's `.gitignore` excludes `episodes/cache/logs/` — that's about the *code* checkout; the data dir gets its own repo.)
2. **Auto-commit each cascade** with **`author-date = the world-time of the triggering session`** (not wall-clock-now). One commit per cascade batch.
3. **Faithful past-self reads are content-addressed, never `git checkout`** (the daemon writes continuously; a checkout would race it):
   ```
   sha = git rev-list -1 --before="<T>" HEAD
   content = git show <sha>:cache/weeks/work/2026-W23.md
   ```
4. **Live files keep being overwritten** by `atomicWrite` as today — git history is what preserves the contemporaneous view. The bug today isn't that we overwrite; it's that there's *no history at all*, so you only ever see the latest hindsight-saturated version.
5. **Taxonomy pin:** when reviving a past self at time T, resolve *both* the cache content at T *and* `taxonomy.json` at T. A cache built under taxonomy v5 is read against v5's node meanings.

This is exactly the TODO "faithful past-selves" design; the interest-cache work makes it mandatory rather than optional.

> **Automation and versioning are orthogonal.** "The agent re-sorts on its own" does **not** mean "unversioned." Every automated re-sort is still a commit. We drop the human from the *loop* without dropping the *boundary*.

### 3.4 Cache partition

Cache path gains an interest axis:

```
cache/<level>/<interest-id>/<ref>.md
  e.g. cache/weeks/work/2026-W23.md
       cache/weeks/music.promptaudio/2026-W23.md
       cache/weeks/_all/2026-W23.md      # the braided "general" lens, == current behavior
```

- Keep **`_all`** alongside the partitioned caches: it's the general lens and the cheapest fallback, and it preserves today's behavior for anything not yet migrated.
- Dotted ids (`music.promptaudio`) keep the tree shallow; one dir per node id.

**Caches gain frontmatter** (they have none today — pure prose):

```yaml
---
level: week
ref: 2026-W23
interest: work
taxonomy_version: 7
built_at: 2026-06-07T02:50:00Z
model: anthropic/claude-opus-4-8
source_sessions: [019e9f1f-..., 019e9f24-...]   # which sessions fed this
---
<narrative…>
```

> **Required reader change:** `readCache` in *both* `context.ts` and `recall-engine.ts` currently `readFileSync().trim()` and inject the blob raw. They must **strip frontmatter** before injection or it leaks into the LLM. Add a shared `readCacheBody()` helper.

**Building an interest cache** at a level filters by tag membership:
- `recallDay(date, interest)` loads only episodes whose `interests[]` contains `interest` above threshold.
- `recallWeek(week, interest)` reads the `interest`-partitioned **day** caches (not `_all`), etc. up the stack.
- `_all` is built exactly as today (all episodes / all child `_all` caches).

### 3.5 Read-time selection, budget, and projection

**Passive header (`loadContext`) — the highest-leverage seam and the one with no query signal.**
- Default injection = the **spine** interests' caches per layer, **under a token budget** (config `context.budgetTokens`, default e.g. 16K). Today's header is already ~12K uncapped; naive fan-out to ~5 interests × 5 layers ≈ 60K, so the budget becomes load-bearing.
- Selection policy when over budget: prefer (a) higher-salience interests for the current window, (b) shorter layers (today/week) over longer (year) per interest, (c) always include `_all` at the year level as the spine narrative. Sub-interests are **not** injected by default — they're drill-on-demand.
- `loadContext` has zero prompt signal (runs in `before_agent_start` before any user turn), so spine selection is driven by the taxonomy's `spine` + recency, not by classifying the session.

**On-demand recall — extend the ref grammar + add a lens.**
- `refType()` parses an optional interest suffix: `2026-W23/work`, `2026-06/music.promptaudio`. Bare `2026-W23` ⇒ `_all` (back-compat).
- New flag `recall --lens <lens> <ref> "q"`. The lens is a **read-time projection clause** injected into the system prompt over the *same* episode/child content — no new storage. This is the wav-vs-steps mechanism. `recallDay` already runs an LLM over raw episodes, so the lens is a minimal addition there.
- Drill UX: an agent (or Ludvig) "opens" a sub-interest the way it opens a skill — `recall 2026-06/music.promptaudio "…"`.

> Projection (lens) and partition (interest dir) are independent axes. v1 materializes the *interest* partition on disk and keeps *lens* purely read-time. If a lens later proves hot enough to be worth materializing, it becomes another path segment — but not in v1.

### 3.6 Governance — automation by default, human override, absence-survivable

The model agreed in design:

- **Automation by default; absence = consent.** The agent has standing authority to re-sort and propose taxonomy edits. The human's non-response is tacit approval. This is the safe failure mode for a system that must outlive the human's attention.
- **The agent is the shift-detector, not just the executor.** A trigger that waits for Ludvig to *feel* a shift still routes through his attention — the thing we agreed not to depend on. Instead, a job (folded into the midnight `sweep`) computes the **center of mass** of interest tags over a trailing window and compares it to the active spine:
  - a non-spine interest crossing a share threshold over N weeks ⇒ propose **promote**;
  - an active spine interest going quiet for N weeks ⇒ propose **demote to dormant**;
  - a cluster of tags with no matching node ⇒ propose **add**.
  (job search going 0→dominant over two weeks in May is the canonical detectable signal.)
- **Every proposal is applied as a commit** advancing `taxonomy.version`, and writes a **plain-English changelog** entry:
  > `v7 (2026-06-20): split music.promptaudio out from under music into its own spine candidate — session volume tripled over 3 weeks. Demoted jobsearch → dormant (silent 2 weeks post-offer).`
- **The changelog is what makes long absences survivable.** When Ludvig checks in — even three months later — he scans the diff log in two minutes instead of reverse-engineering the current state. The guard against unsupervised drift isn't "the agent sorts well"; it's that **catching up is cheap**. The moment re-engagement gets expensive, he stops doing it and the automation becomes unaccountable.
- **Override path:** `snorrio taxonomy edit` (or hand-edit `taxonomy.json`) → commit → caches rebuild under the new version going forward. **Past caches stay pinned to their version.**
- **Cadence is event-driven** (drift thresholds), not calendar-bound. The spine moves slowly (~quarter speed — that's how fast life-structure actually shifts); leaves churn freely. The **taxonomy commit is the boundary** that pins caches — which collapses the reorg ritual and the faithful-past-self fix into one mechanism.

---

## 4. Required refactors (friction, do these alongside)

1. **Layer registry.** The `["day","week","month","quarter","year"]` list + the `{day:"days",…}` dir map are duplicated across `episode-daemon.ts`, `cascade-decision.ts`, `context.ts`, `recall-engine.ts`. Unify into one module (`layers.ts`) and make it partition-aware before threading interests through.
2. **`readCacheBody()` helper** that strips frontmatter; replace every raw `readFileSync().trim()` cache read in `context.ts` and `recall-engine.ts`.
3. **Poison-guard replication.** Every new cache-write path (per-interest `rebuildCache`, lazy interest sub-summaries in `recall*`) must keep the `summary && !summary.startsWith("[recall:")` guard. Add a `cache-guard`-style test per new path.
4. **Cascade cost control.** Live cascade is unconditional and full-stack; ×N interests would ×N the provider load (and there's no backpressure between cascade and user recall today). Move interest-cache rebuilds behind real **staleness gating** — only rebuild an `(interest, ref)` whose tagged inputs changed. Today only `validateCaches` (sweep-only, mtime-based) has staleness logic; generalize it and use it in live mode for the interest axis. The `_all` cache can stay eager for back-compat.

---

## 5. Phasing

Build in the order of *dependency and standalone value*, smallest risk first.

- **Phase 0 — Versioning (prerequisite).** `git init ~/snorrio`, commit-per-cascade with world-time author-date, content-addressed past-self reads, taxonomy pin plumbing (stamp `taxonomy_version` even before partitioning). Fixes the hindsight / Temporal-Council bug on its own. *Validates: a past-self recall at T returns the contemporaneous view, not today's.*
- **Phase 1 — Tagging + cheap addressability.** Add `interests[]` to episode frontmatter + the tagger + `snorrio retag` backfill. **Do not materialize new caches yet.** Make `recall <ref> --interest work` filter episodes at read time over the existing `_all` content. This tests whether the lens split actually pays off *before* committing to N caches on disk. *Validates: "the music thread of June" is answerable and useful.*
- **Phase 2 — Partition.** Materialize per-interest caches, taxonomy.json artifact + version pin, partition-aware `rebuildCache`/`cascade`/`readCache`, the layer registry refactor, frontmatter on caches + `readCacheBody`. Wire spine selection + budget into `loadContext`.
- **Phase 3 — Governance.** Shift detector in the sweep, changelog, `snorrio taxonomy` edit/override command, automated commits.
- **Phase 4 — Polish.** Lens projection UX, budget tuning, drill ergonomics, dormant-node lifecycle.

Each phase ships with typecheck-clean code + tests (`cascade`-style for decision logic, `cache-guard`-style for every write path) and respects the pre-commit hook.

---

## 6. Open decisions (Ludvig owns the salience-from-above ones)

1. **Seed spine** — which ≤5 top-level interests to start with? Straw man: `family, work, music, system, self`. (His call — the agent sees texture from below, he sees salience from above.)
2. **Drift thresholds** — share % and N-weeks-quiet that trigger promote/demote proposals.
3. **Context budget ceiling** — token cap for the injected header (today ~12K uncapped).
4. **Tag-weight membership threshold** — default 0.15.
5. **Keep `_all`?** — recommend yes (general lens + cheap fallback + back-compat).
6. **Tagger placement** — fold into episode generation (cheaper, recommended) vs. separate classifier pass.
7. **Does the people-graph (PRM) share this infra?** — design the partition/version layer so a second taxonomy (people) can reuse it, but don't build PRM here.

---

## 7. The one-line summary

Keep the commit boundary Ludvig invented (taxonomy advances in discrete versioned commits); let the agent be the one who commits and the one who notices the shift; make every cache pin to its taxonomy version so the past stays faithful; and make catching-up cheap (the changelog) so that automation-by-default is accountable rather than unsupervised. Projection is nearly free and ships read-time; partition is real structure and ships behind versioning, which ships first.
