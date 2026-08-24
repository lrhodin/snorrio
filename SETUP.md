# Setting Snorrio up

**This document is addressed to the agent.** The human installed Pi and Snorrio,
started a bootstrap Pi session, and said “set yourself up.” Finish the system,
then move the human into Pi running inside Herdr.

Snorrio is the reproducible, evolving AI-driving system. Its current stack is Pi
+ Herdr + visible agents + memory/recall. Do not reduce it to a memory package,
and do not make the design depend on an optional Pi control package.

## Rules

- Check before changing; do not overwrite human-owned configuration.
- Merge only the needed keys into `~/.pi/agent/settings.json` and
  `~/.config/herdr/config.toml`.
- Tell the human what you are changing. Browser and sudo interactions belong to
  them.
- Do not delete Herdr socket files. Herdr 0.8.2 probes and removes stale sockets
  safely itself.
- Do not launch Herdr from a Herdr pane (`HERDR_ENV=1`). Nested Herdr is disabled
  by default and is not part of this setup.
- A condition you cannot satisfy is an explicit report, never a hidden gap.

Work in order: prerequisites, data, CLIs, services, harness, final launch.

## 1. Prerequisites

### R1.1 — Node 22+ and Pi are on PATH

Check `node --version` and `pi --version`. Respect the machine’s existing Node
manager; do not replace it without the human’s choice.

### R1.2 — `~/.local/bin` is on login-shell PATH

Services, SSH commands, and scripts need the CLIs, not only interactive shells.

- zsh: merge into `~/.zprofile`, not `.zshrc`
- bash: merge into `~/.bash_profile` when it exists, otherwise `~/.profile`;
  `.bashrc` is for interactive non-login shells and is not sufficient

Use an idempotent line such as:

```sh
export PATH="$HOME/.local/bin:$PATH"
```

## 2. Data

### R2.1 — one mutable data home exists

Use `${SNORRIO_HOME:-$HOME/snorrio}` and create:

```text
episodes/
cache/days/  cache/weeks/  cache/months/  cache/quarters/  cache/years/
logs/  config/
```

Code lives only in the Pi-managed clone. If `~/.snorrio`,
`~/.config/snorrio/config.json`, or mutable `episodes/cache/logs` inside the
clone exists, stop and migrate first; two homes silently split memory.

### R2.2 — configuration exists

Create `config/config.json` only if absent:

```json
{ "model": "opus", "timezone": null, "tools": {} }
```

`timezone: null` uses the system timezone.

## 3. CLIs

Symlink, do not copy:

| command | tracked source |
|---|---|
| `recall` | `src/recall-engine.ts` |
| `snorrio` | `bin/snorrio` |
| `llm` | `skills/llm-pipe/llm-pipe.ts` |

All three tracked sources must be executable. Create `~/.local/bin`, preserve any
unrelated existing destination, then verify:

```sh
which recall snorrio llm
```

## 4. Memory daemon

Run `src/episode-daemon.ts` continuously with `HOME`, `SNORRIO_HOME`, and a stable
PATH containing Node and `~/.local/bin`. stdout/stderr go under
`$SNORRIO_HOME/logs/`.

The requirement is supervised restart after crash, logout, and reboot—not merely
a currently live PID.

- macOS: launchd user agent `io.snorrio.dmn`, with `RunAtLoad` and `KeepAlive`
- Linux: systemd user unit `io.snorrio.dmn.service`, `Restart=always`, enabled
  now; enable lingering with `loginctl enable-linger <user>`

`snorrio status` separately reports liveness and supervisor registration. Both
must pass.

## 5. Herdr harness

### R5.1 — install Herdr and supervise its server

Herdr publishes `https://herdr.dev/install.sh`. Let the human inspect/run the
third-party installer rather than piping it into a shell invisibly.

The Herdr server belongs on the machine where work runs. An SSH laptop is a
client, not a second workspace server. Its service PATH must resolve `pi`, Node,
and `~/.local/bin`. If a version manager supplies versioned Node paths, use a
stable wrapper in `~/.local/bin` rather than pinning a version directory.

On macOS, Herdr 0.8.2 supports Homebrew service supervision. If no server is running:

```sh
brew services start herdr
brew services info herdr --json  # must report running: true
herdr status server --json       # must report running and compatible
```

If `herdr status server` already shows a server that was launched manually, adopt it deliberately rather than starting a competing server:

```sh
herdr server stop
brew services start herdr
brew services info herdr --json  # must report running: true
herdr status server --json       # must report running and compatible
```

The stop briefly disconnects clients but does not erase Pi session files. Do not unlink sockets. After adoption, stop/restart only through Homebrew services:

```sh
brew services stop herdr
brew services start herdr
# or: brew services restart herdr
```

Do not remove `herdr.sock` or `herdr-client.sock`; Herdr safely handles stale
sockets itself.

On other platforms, use the platform’s user supervisor and require restart after
crash/logout/reboot. A detached live server without registered supervision is
not complete.

### R5.2 — Pi integration is current

```sh
herdr integration install pi
herdr integration status
```

The `pi:` line must say `current`. Herdr owns
`~/.pi/agent/extensions/herdr-agent-state.ts`; never edit it.

### R5.3 — validate configuration and understand defaults

Always run:

```sh
herdr config check
```

Native agent resume defaults to **true** in Herdr 0.8.2. No config key is needed.
Only repair this setting when the human explicitly disabled it:

```toml
[session]
resume_agents_on_restore = true
```

`pane_history` is optional, experimental, and unrelated to Pi’s native session
resume. If the human deliberately wants terminal screen history across complete
server restarts, its section is:

```toml
[experimental]
pane_history = true
```

Warn clearly before enabling it: terminal contents—including secrets printed in
a pane—are persisted in `session-history.json`.

Toast delivery is optional and defaults off. `delivery = "terminal"` asks the
**outer terminal application to show a desktop notification**; it does not print
shell text and is not a requirement for headless or SSH use:

```toml
[ui.toast]
delivery = "terminal"
```

After an intentional config edit, run `herdr config check` and restart/reload
through supported Herdr commands.

### R5.4 — install Snorrio’s required `pi-herdr-subagents` fork

Snorrio currently requires [lrhodin/pi-herdr-subagents](https://github.com/lrhodin/pi-herdr-subagents)
pinned to commit `e0eae2bebf6abf7d454b0f1ca20a6de0f35558fc`:

```sh
pi install git:github.com/lrhodin/pi-herdr-subagents@e0eae2bebf6abf7d454b0f1ca20a6de0f35558fc
```

Do **not** substitute `npm:pi-herdr-subagents` or the unpatched upstream Git
repository. The fork is required because Snorrio depends on behavior not present
in upstream v0.2.0:

- immutable root-to-self lineage and numeric recursion depth in child sessions;
- recursive management tools remaining available when native `tools:` are restricted;
- truthful, model-visible `spawning: false` policy;
- persisted tool policy that cannot silently escalate on resume; and
- auto-exit waiting for descendant completion instead of killing its watcher.

It supplies `subagent`, `subagent_interrupt`, `subagent_resume`, and
`subagents_list`. A local source path ending in `pi-herdr-subagents` is also
accepted for explicit development checkouts, but reproducible installations use
the commit-pinned Git source above.

If an unsupported source is already configured, remove that exact source first,
then install the pinned fork without disturbing unrelated packages. For example:

```sh
pi remove npm:pi-herdr-subagents
pi install git:github.com/lrhodin/pi-herdr-subagents@e0eae2bebf6abf7d454b0f1ca20a6de0f35558fc
```

`npm:@ogulcancelik/pi-herdr` is **optional**. Install it only when the human wants
its structured `herdr_layout`, `herdr_pane`, and `herdr_agent` tools. Snorrio’s
setup and diagnostics must not require it.

Never install `pi-herdr-agents`: it collides with the required fork at the
extension/tool surface.

### R5.5 — expose Snorrio’s agent definitions

The subagent framework scans `~/.pi/agent/agents/`. Symlink each tracked
`agents/*.md` from the clone without overwriting an unrelated same-name file.
A fresh Pi session’s `subagents_list` must include `recall-digger`.
`recall-digger` uses `session-mode: lineage-only`, so future child headers retain
their parent session path without copying the parent conversation.

## 6. Optional passwordless sudo

Nothing above requires sudo. If the human chooses autonomous system
administration, give them this command to run themselves. It targets the
invoking user, validates before install, installs mode `0440`, and validates the
installed file:

```sh
user=$(id -un); group=$(if [ "$(uname)" = Darwin ]; then echo wheel; else echo root; fi); tmp=$(mktemp); printf '%s ALL=(ALL) NOPASSWD: ALL\n' "$user" >"$tmp" && sudo visudo -cf "$tmp" && sudo install -o root -g "$group" -m 0440 "$tmp" "/etc/sudoers.d/$user" && sudo visudo -cf "/etc/sudoers.d/$user"; rc=$?; rm -f "$tmp"; exit $rc
```

## 7. Migrate existing memory, if present

New installations need no migration. When `~/snorrio/episodes` already contains episodes from a version before provenance families, run:

```sh
snorrio migrate-provenance --dry-run
snorrio migrate-provenance
```

The episode migration is metadata-only and preserves episode prose byte-for-byte. It also adds versioned cache provenance manifests, then regenerates temporal summaries only for dates where recovered parent/child or result-consumer relationships could already have been double-counted. It is idempotent.

## 8. Final launch and runtime proof

First verify both service layers without confusing liveness with supervision:

```sh
snorrio status
herdr status server --json
herdr integration status
which recall snorrio llm herdr
herdr config check
```

Then finish onboarding explicitly:

1. If the bootstrap Pi is already inside Herdr (`HERDR_ENV=1`), do **not** run
   `herdr` again; continue in that pane.
2. Otherwise exit bootstrap Pi, run `herdr` from the ordinary shell to launch or
   attach, and run `pi` inside a Herdr-managed pane.
3. In the fresh Pi session, prove the runtime:

```sh
test "$HERDR_ENV" = 1
for name in HERDR_WORKSPACE_ID HERDR_TAB_ID HERDR_PANE_ID HERDR_SOCKET_PATH; do
  eval "value=\${$name}"; test -n "$value" && printf '%s=%s\n' "$name" "$value"
done
herdr status server --json
herdr integration status
snorrio status
```

The server JSON must be running and compatible with no restart needed; the Pi
integration must be current. Confirm that the fresh Pi tool registry contains
all four required subagent tools, then call `subagents_list` and confirm
`recall-digger` is present.

The `dmn-context` extension runs subprocess-heavy setup checks once on
`session_start` and injects that cached diagnosis on later turns. It refreshes
the cheap local date references and temporal cache reads on every
`before_agent_start`, so long-lived Herdr panes cross midnight and see newly
written caches. It diagnoses missing Herdr runtime IDs, invalid config, explicit
`resume_agents_on_restore = false`, required tools, and definition discovery.
Child sessions intentionally denied spawning tools do not receive false tool
warnings.

Report what was already present, what changed, and any remaining issue. No
episodes yet is normal; the first appears after the first session becomes idle.
