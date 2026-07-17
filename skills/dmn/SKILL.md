---
description: Manage the episode generation daemon — watch sessions, generate summaries, maintain temporal caches.
---

# DMN — Episode Daemon

The daemon (`io.snorrio.dmn`) watches session directories and generates episodes.

## Data

All data lives in `$SNORRIO_HOME` (default: `~/snorrio/`):

```
episodes/YYYY-MM-DD/<session-id>.md    # episode per session
cache/days/YYYY-MM-DD.md              # day summaries
cache/weeks/YYYY-Www.md               # week summaries
cache/months/YYYY-MM.md               # month summaries
cache/quarters/YYYY-QN.md             # quarter summaries
logs/YYYY-MM-DD.log                   # daily daemon logs
```

## Checking status

```bash
snorrio status
```

Or check the daemon directly:

**macOS (launchd):**
```bash
launchctl list io.snorrio.dmn
```

**Linux (systemd user service):**
```bash
systemctl --user status io.snorrio.dmn.service
```

PID present = running. Check today's log:

```bash
cat ~/snorrio/logs/$(date +%Y-%m-%d).log | tail -20
```

## Flushing

Trigger immediate processing of pending sessions:

```bash
snorrio flush
```

The daemon processes all pending sessions, regenerates day caches, then updates week/month/quarter caches in the background.

## Restarting

**macOS (launchd):**
```bash
launchctl bootout gui/$(id -u)/io.snorrio.dmn
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.snorrio.dmn.plist
```

**Linux (systemd user service):**
```bash
systemctl --user restart io.snorrio.dmn.service
```

Or use the CLI (cross-platform):

```bash
snorrio update    # pulls latest code and restarts daemon
```

## Timing

- **Debounce:** 4 minutes 30 seconds of inactivity triggers episode generation
- **Cascade:** new episode → day cache → week cache (blocking). Month/quarter update in background.
- **Sweep:** midnight sweep catches anything missed during the day
