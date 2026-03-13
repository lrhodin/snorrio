---
description: Manage the episode generation daemon — watch sessions, generate summaries, maintain temporal caches.
---
# Episode Daemon (DMN)

Manages the episode generation daemon — watches pi sessions, generates episode summaries, maintains temporal caches.

## Data location

All data lives in `$SNORRIO_HOME` (default: `~/.snorrio/`):
- `episodes/YYYY-MM-DD/<session-id>.md` — episode summaries
- `cache/{days,weeks,months,quarters}/` — temporal caches
- `logs/YYYY-MM-DD.log` — daemon logs

## Daemon management

The daemon runs as a launchd user agent.

### Install

Installation is handled by the **onboarding** skill. It creates directories, writes the launchd plist, and loads the daemon as part of the guided setup flow.

### Check status
```bash
launchctl list | grep snorrio
# Or check logs:
cat ~/.snorrio/logs/$(date +%Y-%m-%d).log | tail -20
```

### Manual operations
```bash
# One-shot sweep — generate episodes for any sessions missing them
node <package-path>/src/episode-daemon.ts --sweep

# Reprocess a time range (regenerate episodes + caches)
node <package-path>/src/episode-daemon.ts --reprocess 2026-W10
node <package-path>/src/episode-daemon.ts --reprocess 2026-03-05
node <package-path>/src/episode-daemon.ts --reprocess 2026-Q1

# Reprocess from a specific depth (skip episode regeneration)
node <package-path>/src/episode-daemon.ts --reprocess 2026-W10 day
```

### Flush (process pending sessions now)
```bash
touch ~/.snorrio/flush
```

The daemon polls for this file every second. When found, it immediately processes all sessions with pending debounce timers.

## How it works

1. **Watch**: FSEvents on `~/.pi/agent/sessions/` (recursive)
2. **Debounce**: 4:30 after last write to a session file
3. **Generate**: Sends full session context to LLM, gets back a journal entry
4. **Cache cascade**: New episode → rebuild day + week caches. Day boundary → rebuild month. Week boundary → rebuild quarter.
5. **Midnight sweep**: Catches anything the watcher missed
6. **Atomic writes**: All file writes use tmp + rename — no gaps

## Model configuration

The daemon uses the model configured for the `dmn` tool in `~/.config/snorrio/config.json`:
```json
{
  "tools": {
    "dmn": { "model": "opus" }
  }
}
```
