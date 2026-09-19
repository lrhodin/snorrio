# [snorr.io](https://snorr.io)

Snorrio is a reproducible, evolving system for driving AI work. Today that system
is Pi, Herdr, visible subagents, and temporal memory/recall. Pi is the current
agent runtime and Herdr is the current persistent harness; Snorrio is not merely a
memory library, and its architecture is not permanently defined by one optional
Pi control package.

The daemon writes what happened after a session goes quiet—not a transcript, but
an episode of what the work meant. Episodes fold into days, weeks, months,
quarters, and years. Herdr supplies panes that survive disconnects and agents you
can watch, steer, and resume.

Memory, configuration, and session history remain plain text on your machine. Model requests follow the privacy terms of whichever provider you configure.

## Start

Install Node 22 or newer, then:

```sh
npm install -g @earendil-works/pi-coding-agent
pi install https://github.com/lrhodin/snorrio
pi
```

Tell Pi: **set yourself up.** `SETUP.md` is addressed to the agent and is the
authoritative onboarding procedure.

## Required subagent fork

Snorrio currently depends on
[`lrhodin/pi-herdr-subagents`](https://github.com/lrhodin/pi-herdr-subagents) at
commit `2395547f4bc50a1f6202c7598261d1409339aa79`, rather than the upstream npm
package. The fork adds recursive lineage, default recursive tool access through
restricted native-tool allowlists, truthful disabled-spawning policy, safe
resume behavior, descendant-aware auto-exit, reload-safe watchers, idempotent
pane cleanup, and collision-free parallel-spawn artifacts. `SETUP.md` contains the exact
pinned installation and migration commands; setup diagnostics reject unpatched
sources instead of treating the package name alone as sufficient.

Setup is not finished while Pi is still in the bootstrap terminal. After the
agent has configured and verified the services:

1. Exit that bootstrap Pi session.
2. Launch or attach Herdr from an ordinary shell with `herdr`.
3. In a Herdr-managed pane, run `pi` and continue there.

Do not run `herdr` when `HERDR_ENV=1`; that would nest Herdr. Inside the final Pi
pane, runtime verification must show:

```sh
test "$HERDR_ENV" = 1
printf '%s\n' "$HERDR_WORKSPACE_ID" "$HERDR_TAB_ID" "$HERDR_PANE_ID" "$HERDR_SOCKET_PATH"
herdr status server --json
herdr integration status
snorrio status
```

All four Herdr IDs must be nonempty, the server must be compatible/current, the
Pi integration must be `current`, and `pi-herdr-subagents` must expose
`subagent`, `subagent_interrupt`, `subagent_resume`, and `subagents_list` in the
fresh Pi session. `subagents_list` must include `recall-digger`.

MIT

## Integration testing

[Integration Testing](docs/integration-testing.md) describes the live-agent validation procedure and reusable Markdown test assignments for contributors.

## Optional skills

[Jev](skills/jev/SKILL.md) answers typed classification/decision questions over
supplied context. It currently needs a Vercel AI Gateway API key or direct
TypeSafe/Jev access; the bundled helper implements Gateway only. It does not
change recall defaults. Pi discovers it under `skills/jev`.

## Optional standalone extensions

[OpenAI fast](docs/openai-fast.md) requests priority service for explicitly opted-in
OpenAI models. It works without the memory stack and is disabled by default.
