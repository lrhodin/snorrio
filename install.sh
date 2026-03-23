#!/bin/bash
# Snorrio installer — standalone memory system for AI agents.
#
# Usage: curl -fsSL https://raw.githubusercontent.com/lrhodin/snorrio/main/install.sh | bash
#    or: git clone https://github.com/lrhodin/snorrio ~/snorrio && ~/snorrio/install.sh

set -e

SNORRIO_HOME="${SNORRIO_HOME:-$HOME/snorrio}"

# Clone if not already present
if [ ! -d "$SNORRIO_HOME/.git" ]; then
  echo "Cloning snorrio to $SNORRIO_HOME..."
  git clone https://github.com/lrhodin/snorrio "$SNORRIO_HOME"
fi

# Data directories
echo "Creating data directories..."
mkdir -p "$SNORRIO_HOME"/{episodes,cache/{days,weeks,months,quarters},logs}

# Config
if [ ! -f "$HOME/.config/snorrio/config.json" ]; then
  echo "Creating config..."
  mkdir -p "$HOME/.config/snorrio"
  cat > "$HOME/.config/snorrio/config.json" << 'EOF'
{
  "model": "opus",
  "timezone": null,
  "tools": {}
}
EOF
fi

# CLI symlinks
echo "Setting up CLIs..."
mkdir -p "$HOME/.local/bin"
chmod +x "$SNORRIO_HOME/src/recall-engine.ts"
chmod +x "$SNORRIO_HOME/bin/snorrio"
ln -sf "$SNORRIO_HOME/src/recall-engine.ts" "$HOME/.local/bin/recall"
ln -sf "$SNORRIO_HOME/bin/snorrio" "$HOME/.local/bin/snorrio"

# llm wrapper
cat > "$HOME/.local/bin/llm" << WRAPPER
#!/bin/bash
exec node "$SNORRIO_HOME/skills/llm-pipe/llm-pipe.ts" "\$@"
WRAPPER
chmod +x "$HOME/.local/bin/llm"

# PATH
if ! echo "$PATH" | grep -q "$HOME/.local/bin"; then
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$HOME/.zshrc"
  export PATH="$HOME/.local/bin:$PATH"
fi

# Daemon
NODE=$(which node)
NODE_DIR=$(dirname "$NODE")
echo "Setting up daemon..."

cat > "$HOME/Library/LaunchAgents/io.snorrio.dmn.plist" << PLIST
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.snorrio.dmn</string>
  <key>ProgramArguments</key>
  <array>
    <string>$NODE</string>
    <string>$SNORRIO_HOME/src/episode-daemon.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>$HOME</string>
    <key>PATH</key>
    <string>$NODE_DIR:/usr/local/bin:/usr/bin:/bin</string>
    <key>SNORRIO_HOME</key>
    <string>$SNORRIO_HOME</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>$SNORRIO_HOME/logs/daemon-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>$SNORRIO_HOME/logs/daemon-stderr.log</string>
</dict>
</plist>
PLIST

launchctl bootout gui/$(id -u)/io.snorrio.dmn 2>/dev/null || true
launchctl bootstrap gui/$(id -u) "$HOME/Library/LaunchAgents/io.snorrio.dmn.plist"

# Platform adapters
echo "Detecting platforms..."

# Pi
if [ -d "$HOME/.pi/agent" ]; then
  echo "  Pi detected — linking extension..."
  mkdir -p "$HOME/.pi/agent/extensions"
  ln -sf "$SNORRIO_HOME/adapters/pi/dmn-context.ts" "$HOME/.pi/agent/extensions/dmn-context.ts"
fi

# Claude Code
if command -v claude &>/dev/null; then
  echo "  Claude Code detected — hook registration needed."
  echo "  Add to ~/.claude/settings.json under hooks.SessionStart:"
  echo "    { \"type\": \"command\", \"command\": \"node $SNORRIO_HOME/adapters/cc/session-start.mjs\", \"timeout\": 10 }"
fi

echo ""
echo "✓ Snorrio installed at $SNORRIO_HOME"
echo "  recall, snorrio, llm commands available"
echo "  Daemon running as io.snorrio.dmn"
echo ""
echo "  Run 'snorrio status' to verify."
