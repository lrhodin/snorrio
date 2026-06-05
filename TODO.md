# snorrio — TODO

Engineering backlog for the snorrio memory/recall system. Personal and cross-project items live in `~/colter/TODO.md`.

## Recall

- [ ] **Vector search mode for recall** — embed raw session chunks, store in a vector DB, add a `recall --search "query"` mode that finds relevant sessions across the full history without hierarchical drill-down. Solves the "which session did we work on X?" needle-in-a-haystack problem across months/quarters. Experiment: pick an embedding model, chunk strategy, and small vector store (sqlite-vss or similar), index existing episodes, compare retrieval quality against current temporal drill-down. Doesn't replace temporal caches (still needed for orientation) — complementary retrieval path. TurboQuant-style embedding compression could apply later.

- [ ] **Streaming output for CLI recall** — the CLI calls `recall()` without an `onChunk`, so it routes through the non-streaming `apiCall`→`completeSimple` path: the caller sees *zero* output until the entire generation finishes, then a dump. A long-form answer is ~130s of dead silence, indistinguishable from a hang. Fix: wire an `onChunk` in the CLI `main()` that writes text deltas to stdout, routing through the existing streaming path (`apiCallStream`→`piStream`). Turns silence into live progressive output — distinguishable from a hang, visible to a bash timeout, and exposes TTFT-vs-throughput if a real slowdown ever happens. Keep hard-fail-on-overload (a feature: surfaces the decision back to the agent).

- [ ] **recall: track the session's own model by default** — `recall` should, by default, use the same model that was running in the session being recalled rather than a globally-pinned alias. Faithful recall requires the reader model's training cutoff to be ≤ the session's model cutoff (the "third temporal coordinate" — a newer model silently injects knowledge that didn't exist at time T). The daemon and CLI no longer pin `"opus"` (they fall through to the active pi model), but that still isn't the session's model. Plan:
  - Episodes already encode the model in their header comment (`<!-- session: ... | model:opus -->`). Read that and pass it as the modelSpec when recalling a single session.
  - Aggregate levels (day/week/month/…) synthesize across sessions with different models. Leaning toward pinning only at the single-session leaf; keep aggregates on the active model.
  - Map historical model strings to concrete specs, with a graceful fallback + warning when a model has been deprecated and is no longer available.

- [ ] **recall: faithful past-selves — fix temporal-council convergence contamination** — the "temporal council" pattern (convene several past selves at different temporal altitudes — day/week/month/quarter/year — ask the same question, treat *convergence* as signal) produces convergence that is largely artificial. Two distinct leaks:
  1. **Hindsight / regeneration leak.** `episode-daemon.ts` unconditionally rebuilds the full cache stack on every cascade (new episode → day → week → month → quarter → year). So a council member representing past time T does not read the cache as it stood at T — it reads a cache regenerated *now*, by the current model, with full knowledge of how things turned out. The "withhold outcomes" firewall isn't leaking, it's structurally absent: the regenerated summary *is* the outcomes.
  2. **Nesting / non-independence leak (dominant for present-day councils).** The levels were never independent vantage points: `recall 2026` reads the *quarter* caches, `recall 2026-Q2` reads the *month* caches, … down to raw episodes. It's a derivation chain — five council members = one corpus photocopied at five zoom levels, asked whether the photocopies match. Convergence here measures **compression fidelity, not corroboration.**

  Residual signal that does survive: when the day-self (raw, in-the-weeds) and the year-self (arc-level) land on the same recommendation, that conclusion is scale-invariant. Real but weak — *not* "N independent minds concur."

  **The fix — three orthogonal coordinates:**

  | Coordinate | Mechanism | Closes |
  |---|---|---|
  | cache-version-at-T | git-versioned caches + read frozen state | hindsight / regeneration (leak 1) |
  | model-at-T | the model-pin item above | training-cutoff injection |
  | independence | build councils from disjoint session-UUID recalls, not the day→year ladder | nesting / false corroboration (leak 2) |

  - **cache-version-at-T (git).** Put `cache/` (or the whole data dir) under git; auto-commit on each cascade with author-date = world-time. When reviving a T-self, resolve `T → sha` via `git rev-list -1 --before="<T>"` and read frozen state with a bare content-addressed read (`git show <sha>:years/2026.md`), **not** `git checkout` (the daemon writes continuously; a checkout races it).
  - **independence (the leak git can't reach).** A present-day council has no past-T to roll back to — all members sit at HEAD — so the artificiality is pure nesting. Real fix: stop building councils from the compression ladder; convene them from session-UUID recalls of genuinely distinct past sessions (frozen contemporaneous witnesses with disjoint evidence). Only then does "convergence" mean independent corroboration.

## Caches & context injection

- [ ] **Manual ritual layer** — weekly/monthly/quarterly/yearly reviews written together by Ludvig and Colter. Manual versions supersede automated caches. The attention itself is the point — reading and writing the summary shapes the future. Yearly especially should be a sit-down ritual, not automated.

- [ ] **Pure subagent mode** — `--pure` flag for subagents that skips temporal context injection. Env var `SNORRIO_CONTEXT=0` checked by dmn-context.ts. Use case: exploration without echo chamber. A session shaped for the task, not the narrative.

- [ ] **PRM (People Relationship Management)** — skill + graph data store. Markdown files in `data/people/`, one per person. Trust/disclosure layer: different people get different context injection. Build after sync story is settled.

## Episodes & ingest

- [ ] **Credential scrubbing** — redact API keys/credentials from session transcripts before sending to Opus. Pattern-match common formats.

- [ ] **Apple Notes / audio journal → episodes** — new ingest pipeline. Watch for new notes/voice memos, transcribe, generate episodes, feed into day agents. Consider impact on cache invalidation (volatile sources change system prompt every turn).

## Sync & harness

- [ ] **Memory sync topology (general)** — within one person's machines: full file replication. Between people's agents: recall-as-protocol (query, don't replicate). Syncthing for intra-person sync.

- [ ] **Multi-harness support** — make snorrio harness-agnostic. Priority targets: Cursor, Claude Code, GitHub Copilot. Two levels: (1) episode ingestion, (2) context injection.
