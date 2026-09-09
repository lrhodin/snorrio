# OpenAI fast (standalone Pi extension)

`extensions/openai-fast.ts` requests `service_tier: "priority"` on supported
OpenAI requests. It has no memory, daemon, Snorrio configuration, or runtime
imports beyond Node built-ins (the Pi import is type-only). Tested on Pi 0.85.1;
requires Pi's `before_provider_request` replacement-payload hook.

## Install and opt in

Snorrio package users get the extension through normal extension discovery.
Without Snorrio, copy **only** `extensions/openai-fast.ts` to
`~/.pi/agent/extensions/openai-fast.ts`, or pass `pi -e /absolute/path/openai-fast.ts`.
Do not load both copies.

It is **off by default**. Create `~/.pi/agent/openai-fast.json`:

```json
{ "models": ["openai-codex/gpt-6-astra"] }
```

The file is relative to `PI_CODING_AGENT_DIR` if set; `PI_OPENAI_FAST_CONFIG`
can override the entire path. Entries are exact `provider/model` IDs, not globs.
Missing config means off; malformed/unreadable config warns and disables it.
Configuration is read at session start/reload, not during every request.
Run `/reload` in existing Pi sessions after installation/configuration changes.
No change to model selection or thinking effort is made (low stays low).

- `/openai-fast status`: report the current model's request policy and config path.
- `/openai-fast on`: opt the current supported model into priority.
- `/openai-fast off`: stop this extension requesting priority for that model.

Commands apply immediately to subsequent requests, only in this runtime and only
for the selected model. New/resumed/forked sessions and reload restore file
configuration. They do not persist or alter other running agents' settings.
The footer says **priority requested**, not priority confirmed.

## Boundaries and caveats

Only `openai-codex` with `openai-codex-responses`, and `openai` with
`openai-responses` or `openai-completions`, are eligible. Azure, OpenRouter and
other OpenAI-compatible providers are excluded. Custom endpoints registered
under these eligible provider names receive the field too; eligibility does not
prove endpoint/model support. Unsupported servers can reject it: use `off` and
retry. There is no automatic paid retry or fallback.

Enabled mode overrides any existing payload `service_tier`; disabled mode leaves
the payload untouched, including a tier supplied by another extension. Later
extensions may override this one. It does not change reasoning, token budgets,
prompts, tools, credentials, or provider registrations. It covers requests routed
through this Pi hook, not independent SDK/daemon calls.

Priority can consume more subscription quota or cost more. Server entitlement,
actual tier, speedup, and precise quota multiplier are **not verified** by this
extension. Pi 0.85.1's Codex transport applies `onPayload` before serialization for
HTTP/WebSocket and supports `serviceTier`/`service_tier`, but payload rewriting is
not the same as setting the transport's internal options. Local cost estimates
may therefore differ from actual billing; neither estimated costs nor the footer
prove server-selected tier. No response bodies or credentials are logged.

## Verification

`npm run typecheck` and `npm test` cover config validation, request preservation,
provider/API scoping, defaults, model-local toggles and lifecycle resets. Tests
are offline and make no billable requests. The installed Pi loader can also load
this file alone; no memory stack is needed.
