---
name: done
description: Flush pending sessions through the memory daemon
argument-hint:
allowed-tools: [Bash]
---

# /done — Flush Pending Sessions

Triggers the snorrio daemon to immediately process any pending session files instead of waiting for the 4:30 debounce timer.

## Usage

```bash
touch ~/.snorrio/flush
```

Then watch the daemon log for completion:

```bash
tail -f ~/.snorrio/logs/$(date +%Y-%m-%d).log | grep -m1 "Flush:"
```

The daemon generates episodes from pending sessions and regenerates day caches. Week/month/quarter caches update in the background after the flush completes.
