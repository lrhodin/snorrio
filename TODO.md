# snorrio — TODO

Engineering backlog for the snorrio memory/recall system. Personal and cross-project items live in `~/colter/TODO.md`.

## Recall

- [ ] **Yearly recall layer** — needed by April 1 (Q2 crossover). Without it, Q1 context drops out when dmn-context.ts starts injecting Q2. Same pattern as quarter: `recallYear` in recall-engine, year cache in `cache/years/`, dmn-context.ts reads it. Redundant now (same data as Q1), critical once Q2 starts.
- [ ] **Vector search mode for recall** — embed raw session chunks, store in a vector DB, add a `recall --search "query"` mode that finds relevant sessions across the full history without hierarchical drill-down. Solves the "which session did we work on X?" needle-in-a-haystack problem across months/quarters. Experiment: pick an embedding model, chunk strategy, and small vector store (sqlite-vss or similar), index existing episodes, compare retrieval quality against current temporal drill-down. Doesn't replace temporal caches (still needed for orientation) — complementary retrieval path. TurboQuant-style embedding compression could apply later.
- [ ] **Streaming output for CLI recall** — the CLI calls `recall()` without an `onChunk`, so it routes through the non-streaming `apiCall`→`completeSimple` path: the caller sees *zero* output until the entire generation finishes, then a dump. A long-form answer is ~130s of dead silence, indistinguishable from a hang — this is what the 2026-06-02 "recall stalled" incident actually was (instrumented repro: 18.6 KB year narrative = `apiMs` 131.8s, all silent; it was **not** DMN/token contention — 3 concurrent year-level opus calls on the same OAuth token showed zero degradation). Fix: wire an `onChunk` in the CLI `main()` that writes text deltas to stdout, routing through the existing streaming path (`apiCallStream`→`piStream`, now instrumented with TTFT/maxGap under `SNORRIO_AI_TIMING=1`). Turns silence into live progressive output — distinguishable from a hang, visible to a bash timeout, and exposes TTFT-vs-throughput if a real slowdown ever happens. Keep hard-fail-on-overload (a feature: surfaces the decision back to the agent).

## Caches & context injection

- [ ] **Manual ritual layer** — weekly/monthly/quarterly/yearly reviews written together by Ludvig and Colter. Manual versions supersede automated caches. The attention itself is the point — reading and writing the summary shapes the future. Yearly especially should be a sit-down ritual, not automated.
- [ ] **Pure subagent mode** — `--pure` flag for subagents that skips temporal context injection. Env var `SNORRIO_CONTEXT=0` checked by dmn-context.ts. Use case: exploration without echo chamber. A session shaped for the task, not the narrative.
- [ ] **Calendar context injection** — auto-inject this week's calendar events into the DMN context window so the agent sees them without pulling the tool. Calendar reminders are unreliable if the agent has to be walked to the tool. Same pattern as temporal caches: always present, zero-cost to reference.
- [ ] **PRM (People Relationship Management)** — skill + graph data store. Markdown files in `data/people/`, one per person. Trust/disclosure layer: different people get different context injection. Build after sync story is settled.

## Episodes & ingest

- [ ] **Compaction vs fidelity** — compaction destroys verbatim content. Options: (1) avoid compaction — start new sessions and re-seed from recall, (2) generate episode per compaction event. Needs decision.
- [ ] **Credential scrubbing** — redact API keys/credentials from session transcripts before sending to Opus. Pattern-match common formats. Known exposure: financial API setup sessions contain Teller keys.
- [ ] **Apple Notes / audio journal → episodes** — new ingest pipeline. Watch for new notes/voice memos, transcribe, generate episodes, feed into day agents. Consider impact on cache invalidation (volatile sources change system prompt every turn).
- [ ] **Episode frontmatter schema cleanup** — rename `origin` → `harness`, add `model` field (extracted from session JSONL `model_change` events), formalize `agent` field across all episodes. Touch daemon episode generator to produce the new schema. Backfill existing Colter, Kael, and Grok episodes.
- [ ] **Archaeology** — Time Machine backup has pre-W09 pi sessions. Grok and other AI exports. Convert to episodes.

## Sync & harness

- [ ] **Kael → Colter sync** — one-way sync of Kael's `~/.snorrio/` (episodes + caches) to `~/.snorrio/machines/kael/` on Colter via rsync over Tailscale. Launchd job, runs every few minutes. Colter becomes the unified store. Kael gets no Colter data — weekly ritual is the only channel back. Step 1: rsync setup. Step 2: extend recall-engine to search `machines/kael/` for episodes and caches. Step 3: unified synthesis tier that loads both machines' caches into one context window for cross-domain pattern discovery. Unified tier available for recall but NOT auto-injected into DMN context. Colter's own cache stays pure.
- [ ] **Memory sync topology (general)** — within one person's machines: full file replication. Between people's agents: recall-as-protocol (query, don't replicate). Syncthing for intra-person sync.
- [ ] **Multi-harness support** — make snorrio harness-agnostic. Priority targets: Cursor, Claude Code, GitHub Copilot. Two levels: (1) episode ingestion, (2) context injection.
