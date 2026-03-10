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

### 1. Data directories

```bash
mkdir -p ~/.snorrio/{episodes,cache/{days,weeks,months,quarters,years},logs}
```

### 2. Config file

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

### 3. Launchd daemon

Find the snorrio package directory (this skill's grandparent: resolve `SKILL.md` → `skills/onboarding/` → package root). Find node (`which node`).

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
    <string>NODE_DIR:/usr/local/bin:/usr/bin:/bin</string>
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

Replace `NODE_PATH`, `NODE_DIR` (dirname of node binary), `PACKAGE_DIR`, and `HOME_DIR` with actual values.

Then load it:

```bash
launchctl bootout gui/$(id -u)/io.snorrio.dmn 2>/dev/null || true
launchctl bootstrap gui/$(id -u) ~/Library/LaunchAgents/io.snorrio.dmn.plist
```

Verify it's running: `launchctl list io.snorrio.dmn` — exit status 0 and PID present means success.

### 4. Recall CLI

Make the recall engine executable and symlink it to `~/.local/bin/` (user-local, no sudo needed):

```bash
chmod +x PACKAGE_DIR/src/recall-engine.mjs
mkdir -p ~/.local/bin
ln -sf PACKAGE_DIR/src/recall-engine.mjs ~/.local/bin/recall
```

If `~/.local/bin` is not on PATH, add it to `~/.zshrc`:

```bash
export PATH="$HOME/.local/bin:$PATH"
```

Verify: `which recall` (may need `source ~/.zshrc` or a new shell first).

### 5. Passwordless sudo (optional)

Ask the user if they want passwordless sudo. Explain: this lets the agent run privileged commands (e.g., system config, network tools) without interrupting you for a password. It's not required for snorrio itself, but useful for a full-autonomy agent setup.

If they want it:

```bash
# Create a sudoers drop-in file (safer than editing /etc/sudoers directly)
sudo bash -c 'echo "USERNAME ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/USERNAME && chmod 0440 /etc/sudoers.d/USERNAME'
```

Replace `USERNAME` with the output of `whoami`. The user will need to enter their password this one time.

Verify: `sudo -n true && echo "passwordless sudo works"`.

If they decline, note in APPEND_SYSTEM.md that sudo requires a password so future sessions know to ask before running privileged commands.

### 6. Verify

Run a quick smoke test:
- `launchctl list io.snorrio.dmn` — daemon running
- `recall` — CLI accessible
- `ls ~/.snorrio/` — directories exist
- `cat ~/.config/snorrio/config.json` — config present
- `cat ~/.pi/agent/APPEND_SYSTEM.md` — identity exists

Report results to the user.

## After onboarding

Once setup is complete, this skill is dormant. The agent's identity is established and the daemon is running.
