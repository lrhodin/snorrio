---
name: handoff
description: Write a handoff prompt when approaching context limits or ending a session that needs continuation.
---

# Handoff

Write a handoff prompt so the next session picks up cleanly. Structure it however fits the situation — the only hard requirements:

1. **Include your session ID** so the next session can `recall <id> "question"` to drill into you.
2. **Give enough context** that the next session doesn't need to recall unless it wants details.

## Session ID

Sessions live under `~/.pi/agent/sessions/`, organized by cwd-encoded directory. Find the current session:

```bash
ls -lt ~/.pi/agent/sessions/$(pwd | sed 's|/|-|g; s|^|-|; s|$|--|')/ | head -1
```

Or just list the most recently modified session directory:

```bash
ls -lt ~/.pi/agent/sessions/ | head -5
```

UUID is after the timestamp: `2026-03-09T17-11-33-541Z_53e7aa2b-...` → `53e7aa2b`.

## Delivery

- **Local**: `pbcopy` if available, so the user can paste into a new session.
- **Remote / file-based**: write the handoff to a known location (e.g. `~/handoff.md`) and tell the user how to start the next session by reading it.

When telling the user how to start the next session, never end the command with punctuation — it makes copy-paste harder.
