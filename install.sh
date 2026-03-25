#!/usr/bin/env bash
set -euo pipefail

# snorrio installer
# curl -sSL snorr.io/install | bash

SNORRIO_HOME="${SNORRIO_HOME:-$HOME/snorrio}"
CONFIG_DIR="$HOME/.config/snorrio"
BIN_DIR="$HOME/.local/bin"
PI_DIR="$HOME/.pi/agent"

main() {
  echo "snorrio — installing..."
  echo ""

  check_deps
  clone_repo
  create_dirs
  create_config
  install_cli
  install_pi_extensions
  register_skills
  install_daemon
  ensure_path

  echo ""
  echo "done."
  echo ""
  echo "  launch pi to get started"
  echo ""
}

check_deps() {
  if ! command -v node &>/dev/null; then
    echo "error: node not found. install node >= 22 first."
    exit 1
  fi

  if ! command -v pi &>/dev/null; then
    echo "error: pi not found. install pi first:"
    echo "  npm install -g @mariozechner/pi-coding-agent"
    exit 1
  fi

  NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
  if [ "$NODE_MAJOR" -lt 22 ]; then
    echo "error: node $NODE_MAJOR found, need >= 22 (for native TypeScript)"
    exit 1
  fi
}

clone_repo() {
  if [ -d "$SNORRIO_HOME/.git" ]; then
    echo "  repo exists, pulling..."
    git -C "$SNORRIO_HOME" pull --ff-only --quiet 2>/dev/null || true
  else
    echo "  cloning..."
    git clone --quiet https://github.com/lrhodin/snorrio "$SNORRIO_HOME"
  fi
}

create_dirs() {
  mkdir -p "$SNORRIO_HOME"/{episodes,cache/{days,weeks,months,quarters},logs}
}

create_config() {
  mkdir -p "$CONFIG_DIR"
  if [ ! -f "$CONFIG_DIR/config.json" ]; then
    cat > "$CONFIG_DIR/config.json" << 'EOF'
{
  "model": "opus",
  "timezone": null,
  "tools": {}
}
EOF
    echo "  created config"
  fi
}

install_cli() {
  mkdir -p "$BIN_DIR"

  ln -sf "$SNORRIO_HOME/src/recall-engine.ts" "$BIN_DIR/recall"
  chmod +x "$SNORRIO_HOME/src/recall-engine.ts"

  ln -sf "$SNORRIO_HOME/bin/snorrio" "$BIN_DIR/snorrio"
  chmod +x "$SNORRIO_HOME/bin/snorrio"

  ln -sf "$SNORRIO_HOME/skills/subagent/subagent.mjs" "$BIN_DIR/subagent"
  chmod +x "$SNORRIO_HOME/skills/subagent/subagent.mjs"

  cat > "$BIN_DIR/llm" << 'WRAPPER'
#!/bin/bash
exec node ~/snorrio/skills/llm-pipe/llm-pipe.ts "$@"
WRAPPER
  chmod +x "$BIN_DIR/llm"

  echo "  installed CLIs: recall, snorrio, subagent, llm"
}

install_pi_extensions() {
  mkdir -p "$PI_DIR/extensions"

  ln -sf "$SNORRIO_HOME/adapters/pi/dmn-context.ts" "$PI_DIR/extensions/dmn-context.ts"
  ln -sf "$SNORRIO_HOME/adapters/pi/subagent-signal.ts" "$PI_DIR/extensions/subagent-signal.ts"

  echo "  linked pi extensions"
}

register_skills() {
  local settings="$PI_DIR/settings.json"
  if [ ! -f "$settings" ]; then
    # pi hasn't been run yet — create minimal settings with skills path
    mkdir -p "$PI_DIR"
    cat > "$settings" << EOF
{
  "skills": ["~/snorrio/skills"]
}
EOF
    echo "  created pi settings with skills path"
    return
  fi

  # Check if snorrio skills are already registered
  if grep -q "snorrio/skills" "$settings" 2>/dev/null; then
    return
  fi

  # Add snorrio skills path to existing settings
  if command -v node &>/dev/null; then
    node -e "
      const fs = require('fs');
      const s = JSON.parse(fs.readFileSync('$settings', 'utf8'));
      s.skills = s.skills || [];
      if (!s.skills.some(p => p.includes('snorrio/skills'))) {
        s.skills.push('~/snorrio/skills');
      }
      fs.writeFileSync('$settings', JSON.stringify(s, null, 2) + '\n');
    "
    echo "  registered skills in pi settings"
  fi
}

install_daemon() {
  local NODE_BIN
  NODE_BIN=$(which node)
  local NODE_DIR
  NODE_DIR=$(dirname "$NODE_BIN")
  local PLIST="$HOME/Library/LaunchAgents/io.snorrio.dmn.plist"

  mkdir -p "$HOME/Library/LaunchAgents"

  cat > "$PLIST" << EOF
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>io.snorrio.dmn</string>
  <key>ProgramArguments</key>
  <array>
    <string>${NODE_BIN}</string>
    <string>${SNORRIO_HOME}/src/episode-daemon.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>${BIN_DIR}:${NODE_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>SNORRIO_HOME</key>
    <string>${SNORRIO_HOME}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${SNORRIO_HOME}/logs/daemon-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${SNORRIO_HOME}/logs/daemon-stderr.log</string>
</dict>
</plist>
EOF

  launchctl bootout "gui/$(id -u)/io.snorrio.dmn" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"

  # Verify
  if launchctl list io.snorrio.dmn &>/dev/null; then
    echo "  daemon started"
  else
    echo "  warning: daemon failed to start — check logs at $SNORRIO_HOME/logs/"
  fi
}

ensure_path() {
  # Check if ~/.local/bin is in PATH
  if echo "$PATH" | grep -q "$BIN_DIR"; then
    return
  fi

  local shell_rc
  case "${SHELL:-/bin/zsh}" in
    */zsh)  shell_rc="$HOME/.zshrc" ;;
    */bash) shell_rc="$HOME/.bashrc" ;;
    *)      shell_rc="$HOME/.profile" ;;
  esac

  if [ -f "$shell_rc" ] && grep -q '.local/bin' "$shell_rc" 2>/dev/null; then
    return
  fi

  echo '' >> "$shell_rc"
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$shell_rc"
  echo "  added ~/.local/bin to PATH in $(basename "$shell_rc")"
}

main "$@"
