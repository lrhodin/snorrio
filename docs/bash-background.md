# Bash background

`extensions/bash-background.ts` replaces pi's `bash` tool with a wrapper that can
let go of a running command without killing it. Calls never detached behave
exactly like the built-in tool.

Without Snorrio, copy **only** `extensions/bash-background.ts` to
`~/.pi/agent/extensions/`, or pass `pi -e /absolute/path/bash-background.ts`.

## Use

- **`cmd+ctrl+b`** (`ctrl+super+b`) while a bash call runs: the call returns at
  once with the output so far and a job ID. The command keeps running; `Esc` no
  longer stops it, and the call's `timeout` no longer applies.
- When the job ends, its exit code, duration, and last 50 lines reach the model
  as one message. Idle: it starts a turn. Busy: it steers the current turn.
- `/jobs` lists jobs. `/kill` picks a running job from a list and stops it and its
  child processes; `/kill <id>` skips the list.
- The model gets `bg_status` and `bg_kill` for the same. It cannot start a
  background job itself; only the key detaches.
- Full output of every job: `~/.pi/agent/bg/`. Quitting or reloading pi kills
  running jobs.

With several bash calls running in parallel, the key detaches the most recent.

## Terminal requirement

`super` reaches pi only through the Kitty keyboard protocol. The terminal, and
any multiplexer between it and pi, must forward it. If the key does nothing,
check that first.
