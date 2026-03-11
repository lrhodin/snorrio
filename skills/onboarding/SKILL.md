# Onboarding

When a user installs snorrio for the first time, guide them through identity creation and system setup.

## Detection

Check if `~/.pi/agent/APPEND_SYSTEM.md` exists. If it does, skip to **Setup checklist** (the user may be re-onboarding on a new machine with an existing identity).

## Identity flow

1. **Introduction**: Explain that APPEND_SYSTEM is their agent's identity — it defines who the agent is, how it works, and what it knows. It travels with every session.

2. **Core identity**: Ask:
   - What should I call you? (the human)
   - What should your agent's name be? (or should it just be "your agent"?)
   - What machine is this? (e.g., "work laptop", "home desktop", "Kat's MacBook")

3. **Working style**: Ask:
   - What principles matter to you when working with an agent? (e.g., "keep it simple", "ask before running destructive commands", "be direct")
   - Any trust model preferences? (e.g., full autonomy, ask before installs, etc.)

4. **Context**: Ask:
   - What do you primarily use this machine for?
   - Anyone else the agent should know about? (family, team, etc.)
   - Any tools, services, or accounts that are important?

5. **Generate**: Write `~/.pi/agent/APPEND_SYSTEM.md` with the gathered information, structured as:
   - Soul (name, identity)
   - Principles
   - Trust model
   - Operating context
   - Memory system (snorrio — point to `~/.snorrio/`)

The tone should be conversational, not a form. Build the identity through dialogue.

## Setup checklist

After identity exists (or if it already did), walk through these steps. Check each one — skip if already done.

### 1. pi login

The user needs to authenticate pi for OAuth/LLM access. Without this, recall and llm-pipe won't work.

```bash
pi
# Then run /login inside pi and follow the OAuth flow
```

Check if already authenticated: look for credentials in `~/.pi/agent/settings.json` — if `defaultProvider` is set, they're logged in.

### 2. Data directories

```bash
mkdir -p ~/.snorrio/{episodes,cache/{days,weeks,months,quarters,years},logs}
```

### 3. Config file

If `~/.config/snorrio/config.json` doesn't exist, create it:

```json
{
  "provider": null,
  "model": "opus",
  "timezone": null,
  "tools": {}
}
```

- `timezone`: auto-detected from the system if null. The user can override (e.g., `"America/New_York"`).
- `tools`: empty by default. Skills add their own entries when installed (e.g., `"dmn": { "model": "opus" }`).

Ask the user if they want to change any defaults (e.g., provider, model preferences, timezone).

### 4. PATH setup

Check if `~/.local/bin` is on PATH. If not, add to shell profile:

```bash
mkdir -p ~/.local/bin

# Add to PATH if not already there
if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
  SHELL_RC="$HOME/.zshrc"
  [ -n "$BASH_VERSION" ] && SHELL_RC="$HOME/.bashrc"
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$SHELL_RC"
  export PATH="$HOME/.local/bin:$PATH"
fi
```

### 5. CLI wrappers

Find the snorrio package directory (this skill's grandparent: resolve `SKILL.md` → `skills/onboarding/` → package root). Use that as `PACKAGE_DIR`.

Both wrappers are simple — `ai.mjs` finds pi dynamically at runtime, no `NODE_PATH` needed.

**recall** — symlink to the recall engine:

```bash
chmod +x PACKAGE_DIR/src/recall-engine.mjs
ln -sf PACKAGE_DIR/src/recall-engine.mjs ~/.local/bin/recall
```

**llm** — wrapper script (needs to find the skill directory at runtime):

```bash
cat > ~/.local/bin/llm << 'WRAPPER'
#!/bin/bash
exec node "PACKAGE_DIR/skills/llm-pipe/llm-pipe.mjs" "$@"
WRAPPER
chmod +x ~/.local/bin/llm
```

Replace `PACKAGE_DIR` with the actual resolved path.

Verify both:
```bash
which recall && which llm
echo "test" | llm "respond with one word"
```

### 6. Launchd daemon (macOS)

Find node path (`which node`).

Write `~/Library/LaunchAgents/io.snorrio.dmn.plist`:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.snorrio.dmn</string>
  <key>ProgramArguments</key>
  <array>
    <string>NODE_PATH</string>
    <string>PACKAGE_DIR/src/episode-daemon.mjs</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>HOME_DIR</string>
    <key>PATH</key>
    <string>NODE_BIN_DIR:/usr/local/bin:/usr/bin:/bin</string>
    <key>SNORRIO_HOME</key>
    <string>HOME_DIR/.snorrio</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>HOME_DIR/.snorrio/logs/daemon-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>HOME_DIR/.snorrio/logs/daemon-stderr.log</string>
</dict>
</plist>
```

Replace `NODE_PATH` (full path to node binary), `NODE_BIN_DIR` (dirname of node), `PACKAGE_DIR`, and `HOME_DIR` with actual values.

Then load it:

```bash
launchctl bootout gui/$(id -u)/io.snorrio.dmn 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.snorrio.dmn.plist
```

Verify: `launchctl list io.snorrio.dmn` — exit status 0 and PID present means success.

### 7. Passwordless sudo (optional)

Ask the user if they want passwordless sudo. Explain: this lets the agent run privileged commands without interrupting you for a password. It's not required for snorrio itself, but useful for full agent autonomy.

If they want it:

```bash
sudo bash -c 'echo "USERNAME ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/USERNAME && chmod 0440 /etc/sudoers.d/USERNAME'
```

Replace `USERNAME` with the output of `whoami`. The user will need to enter their password this one time.

If they decline, note in APPEND_SYSTEM.md that sudo requires a password.

### 8. Verify

Run a quick smoke test:
- `launchctl list io.snorrio.dmn` — daemon running
- `recall` — CLI accessible
- `echo "test" | llm "one word"` — llm-pipe works
- `ls ~/.snorrio/` — directories exist
- `cat ~/.config/snorrio/config.json` — config present
- `cat ~/.pi/agent/APPEND_SYSTEM.md` — identity exists

Report results to the user.

## After onboarding

Once setup is complete, this skill is dormant. The agent's identity is established and the daemon is running.
