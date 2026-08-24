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

- **Debounce:** 55 minutes of inactivity triggers episode generation. Sized to sit just inside Anthropic's 1-hour prompt cache, so a session that resumes still reads its transcript prefix from cache. Run `snorrio flush` to skip the wait — it cancels pending timers and reconciles against disk.
- **Cascade:** new episode → day cache → week cache (blocking). Month/quarter update in background. A full day→year cascade is five serial LLM calls, roughly 7 minutes; the debounce window is what keeps it from re-running under an active session.
- **Sweep:** midnight sweep catches anything missed during the day
