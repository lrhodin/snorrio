# Setting snorrio up

**This document is addressed to an agent, not to a human.** The human ran three
commands and handed the machine to you. Finish the job.

There is no installer. What follows is a list of **conditions that must be true**
when you are done, with the reasoning behind each one and the exact values that
cannot be guessed. How you satisfy them is yours to decide, because it depends on
the machine you are on — and you can see the machine, whereas a script written
months ago cannot.

Work in this order: prerequisites, data, services, harness, verification. Later
requirements assume earlier ones hold.

**Rules for you while doing this:**

- **Check before you change.** Every requirement here may already be satisfied.
  Re-running is normal; clobbering someone's existing config is not.
- **Never overwrite a config file that already exists.** `~/.pi/agent/settings.json`
  and `~/.config/herdr/config.toml` belong to the human and may hold work unrelated
  to snorrio. Merge the keys named below into what is there. Do not template the
  file.
- **Tell the human what you are about to do to their machine, then do it.** Do not
  ask permission for each step; do not go silent for twenty commands either.
- **Anything needing `sudo` or a browser is theirs, not yours.** Print the exact
  command or URL and wait.
- **A requirement you cannot satisfy is a report, not a failure to hide.** Say
  which one, say why, move on to the rest.

---

## 1. Prerequisites

**R1.1 — node 22 or newer is installed and on PATH.**
Everything here is TypeScript run directly by node. If the human's node is older,
say so and let them choose how to upgrade; their machine may have opinions
(a version manager, a package manager, a work-managed install) that you should not
override.

**R1.2 — `pi` is installed and on PATH.**
`npm install -g @earendil-works/pi-coding-agent`. If you are reading this, it is
already true.

**R1.3 — `~/.local/bin` is on PATH for login shells, not just interactive ones.**
The CLIs in R3 land there, and services and SSH commands must be able to find them.

On zsh this means `~/.zprofile`, **not** `~/.zshrc`. `.zshrc` covers interactive
shells only, which once left `snorrio` and `recall` unfindable from scripts and
`ssh host cmd` while working perfectly in a terminal tab. On bash, `~/.bashrc`.

---

## 2. Data

**R2.1 — the data home exists, with its full subtree.**
Default `~/snorrio`, overridable by `SNORRIO_HOME`. Code only ever lives in the
pi-managed clone; everything mutable lives here:

```
episodes/  cache/{days,weeks,months,quarters,years}/  logs/  config/
```

The cache subdirectories are load-bearing — the cascade writes into them by name
and does not create them.

**R2.2 — `config/config.json` exists.**

```json
{ "model": "opus", "timezone": null, "tools": {} }
```

`timezone: null` means auto-detect from the system; set it explicitly (e.g.
`"America/Los_Angeles"`) only if the machine's clock lies about where the human is.

**R2.3 — if a pre-`~/snorrio` layout is present, stop and migrate first.**
Old installs kept state at `~/.snorrio`, `~/.config/snorrio/config.json`, or inside
the package clone itself. Two data homes means episodes silently written to one and
read from the other. Move the data, then continue.

---

## 3. CLIs

**R3.1 — `recall`, `snorrio`, and `llm` are executable and on PATH.**
Symlink them out of the clone rather than copying, so `git pull` updates them in
place:

| CLI | Source in the clone |
|---|---|
| `recall` | `src/recall-engine.ts` |
| `snorrio` | `bin/snorrio` |
| `llm` | `skills/llm-pipe/llm-pipe.ts` |

`which recall snorrio llm` is the test.

---

## 4. The memory daemon

**R4.1 — the episode daemon runs continuously, and comes back by itself after a
crash, a logout, and a power cycle.**

This is the requirement, not any particular way of achieving it. The daemon is
`src/episode-daemon.ts`, run by node. It watches session directories and writes an
episode once a session has been quiet for 4.5 minutes. If it is not running when a
session ends, that session's memory is simply never formed, and the only evidence
is a log nobody reads. That is why *unsupervised restart* is the actual
requirement: a daemon that needs a human to notice it died has already failed.

It needs three environment values, because a supervised process does not inherit
the human's shell: `HOME`, `SNORRIO_HOME`, and a `PATH` containing both node and
`~/.local/bin`. Send stdout and stderr to files under `$SNORRIO_HOME/logs/`.

Use the machine's own supervisor. On macOS that is a launchd user agent
(`~/Library/LaunchAgents/io.snorrio.dmn.plist`, `RunAtLoad` and `KeepAlive` both
true, loaded with `launchctl bootstrap gui/$(id -u)`). On Linux it is a systemd
user service (`~/.config/systemd/user/io.snorrio.dmn.service`, `Restart=always`).

**R4.2 — on Linux, lingering is enabled for the user.**
`loginctl enable-linger <user>`. Without it, systemd tears down the whole user
manager when the last session ends, so a headless or SSH-only box loses the daemon
the moment the human disconnects. This has no macOS equivalent; launchd user agents
persist on their own.

**R4.3 — `snorrio status` reports the daemon running with a PID.**
Not "the unit is loaded". A PID.

---

## 5. The harness: herdr

Snorrio's memory and the herdr harness ship together and are not separable. The
memory layer answers *what happened before*; the harness is *how work happens now* —
persistent panes, agents that survive a disconnect, and subagents that run in their
own terminals instead of hidden inside a tool call. Installing one without the other
gives you half a system.

**R5.1 — the `herdr` binary is installed and on PATH.**
Upstream serves an install script at `https://herdr.dev/install.sh`. Show the human
the URL and let them run it, or read it first and tell them what it does. Do not
pipe a third party's script into a shell on their behalf without their eyes on it.

**R5.2 — the herdr server runs on the machine the work happens on, under the same
unsupervised-restart requirement as R4.1.**

If the human works over SSH, the server belongs on the remote box and their laptop
is only a client. Panes, agents and processes all live wherever the server lives.
Running a second server locally splits the workspace in two.

Two details that are not inferable and will cost an hour each:

- **Clear stale sockets before starting.** A server killed without a clean shutdown
  leaves `herdr.sock` and `herdr-client.sock` behind in `~/.config/herdr/`, and the
  next start fails quietly. Attempt a `herdr server stop`, remove both socket paths,
  then start. Under a supervisor these belong in pre-start hooks, each tolerating
  its own failure.
- **`PATH` must let the server find your agent binaries.** Agent detection works by
  recognizing the process in a pane. If `pi` is not on the server's `PATH`, panes run
  agents that herdr cannot see, and every lifecycle feature degrades to a dumb
  terminal.

**R5.3 — `pi` and `node` resolve through stable paths that survive a version-manager
upgrade.**

If node comes from a version manager (nvm, fnm, asdf, volta), its real path contains
a version number that changes under you. A supervisor config pinned to
`.../v24.18.0/bin/node` starts failing the day the human upgrades node, and the
symptom is not an error message — it is panes that open and look dead.

Where a version manager is in play, put small wrapper scripts in `~/.local/bin` that
resolve the current default at exec time (for nvm: source `nvm.sh --no-use`, take
`nvm which default`, exec the real binary), and give the service a `PATH` containing
`~/.local/bin` and no version directory at all. On a system or Homebrew node the
paths are already stable; skip this.

**R5.4 — herdr's pi integration hook is installed.**

```bash
herdr integration install pi
```

This writes `~/.pi/agent/extensions/herdr-agent-state.ts`, which reports each pane's
pi session back to the server. It is what makes agent state visible and resume
possible. The file is managed by herdr and overwritten on reinstall — never edit it.

**R5.5 — agent panes resume their conversation across a server restart.**

Merge into `~/.config/herdr/config.toml`:

```toml
[session]
resume_agents_on_restore = true

[remote]
pane_history = true
```

Apply with `herdr server reload-config`. Panes then relaunch their agent and
`/resume` into the same session file after a restart or reboot, scrollback included.
pi's session files are durable on disk, so this holds even when the processes are
killed.

**Caveat worth telling the human:** only panes created *after* R5.4's hook exists
carry a session reference. Existing panes need cycling once before they can resume.

**R5.6 — if the machine has no desktop, toasts are delivered to the terminal.**

```toml
[ui.toast]
delivery = "terminal"
```

The default reaches for a desktop notifier. On a headless box there is none, so
notifications vanish silently. Set this on any machine you reach over SSH.

**R5.7 — both herdr pi packages are installed.**

- `npm:@ogulcancelik/pi-herdr` — the `herdr_layout` / `herdr_pane` / `herdr_agent`
  tools, i.e. panes, tabs, and driving agents.
- `npm:pi-herdr-subagents` — `subagent`, `subagent_interrupt`, `subagent_resume`,
  `subagents_list`. Fire-and-forget spawning; each subagent gets its own visible
  pane, and the harness wakes the parent with the result.

Add them to the `packages` array in `~/.pi/agent/settings.json`, alongside the
snorrio entry, then verify the tools appear in a fresh session.

**Do not install `pi-herdr-agents`.** Different package, different author, similar
name. It registers at the same extension path and defines a `subagent` tool of its
own, so it collides with `pi-herdr-subagents` rather than complementing it.

**R5.8 — snorrio's subagent definitions are discoverable.**
`agents/*.md` in the clone must be visible to the subagent framework, which scans
`~/.pi/agent/agents/`. Symlink each file rather than copying, so a `git pull` updates
them. `subagents_list` should then show them, `recall-digger` among them.

---

## 6. Optional: passwordless sudo

Everything above is user-scoped and needs no sudo. Going forward, though, system
tasks will — and a password prompt stalls an agent working while the human is away.

Ask whether they want it. If yes, give them the command to run themselves:

```
sudo sh -c 'echo "$(whoami) ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/$(whoami)'
```

Their call, and the last thing they should have to type.

---

## 7. Verify, then say what you did

```bash
snorrio status          # daemon PID, data home, episode count, config, version
herdr status            # client and server, versions, socket path
which recall snorrio llm herdr
```

Then start a fresh pi session. The session-start check re-runs all of this every
time and will name anything still missing, which is the real safety net — a
one-time installer verifies once, whereas this verifies daily.

Report to the human: what was already in place, what you changed, what you could
not satisfy and why. If nothing is outstanding, say that plainly and get to work.

**No episodes yet is normal.** The first one appears after this session ends.

---

## Coming from raw tmux

Habits that need dropping, if the machine was running bare tmux before:

- **The server is not on your laptop.** It runs where the work runs; the laptop
  attaches to it.
- **Agent panes are driven through the agent tools**, not by typing keystrokes into
  them. Raw input into an agent pane corrupts lifecycle detection, and lifecycle
  detection is what the harness is for.
- **Long-lived services do not live in panes.** Anything that must survive you
  closing the terminal belongs to the machine's supervisor. Panes are for work you
  are watching.
- **Subagents are visible.** They run in their own panes, so you can watch one work
  and steer it mid-task. That is a different working style from a tool call that
  returns a wall of text when it is done.
