#!/usr/bin/env bash
set -euo pipefail

# snorrio installer
# curl -sSL snorr.io/install | bash

DATA_HOME="${SNORRIO_HOME:-$HOME/snorrio}"
CONFIG_DIR="$DATA_HOME/config"
BIN_DIR="$HOME/.local/bin"
PACKAGE_DIR="$HOME/.pi/agent/git/github.com/lrhodin/snorrio"

main() {
  echo "snorrio — installing..."
  echo ""

  detect_legacy_layout
  install_homebrew
  install_node
  install_pi
  install_snorrio
  create_dirs
  create_config
  install_cli
  install_daemon
  install_dev_hooks
  ensure_path

  echo ""
  echo "done."
  echo ""
  echo "  launch pi to get started"
  echo ""
}

# ── Legacy layout detection ──

detect_legacy_layout() {
  local found=()

  [ -e "$HOME/.snorrio" ] && found+=("$HOME/.snorrio")
  [ -e "$HOME/.config/snorrio/config.json" ] && found+=("$HOME/.config/snorrio/config.json")

  for path in episodes cache logs flush; do
    [ -e "$PACKAGE_DIR/$path" ] && found+=("$PACKAGE_DIR/$path")
  done

  if [ ${#found[@]} -eq 0 ]; then
    return
  fi

  echo "legacy snorrio layout detected:"
  for path in "${found[@]}"; do
    echo "  - $path"
  done
  echo ""
  echo "snorrio now expects mutable state in:"
  echo "  $DATA_HOME"
  echo ""
  echo "Do the one-time manual migration first, then rerun install."
  echo ""
  echo "Target layout:"
  echo "  $DATA_HOME/episodes"
  echo "  $DATA_HOME/cache"
  echo "  $DATA_HOME/logs"
  echo "  $CONFIG_DIR/config.json"
  echo ""
  exit 1
}

# ── Prerequisites ──

install_homebrew() {
  if command -v brew &>/dev/null; then return; fi
  echo "  installing homebrew..."
  NONINTERACTIVE=1 /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" </dev/null
  eval "$(/opt/homebrew/bin/brew shellenv)"
}

install_node() {
  if [ -x /opt/homebrew/bin/brew ]; then
    eval "$(/opt/homebrew/bin/brew shellenv)"
  fi

  if command -v node &>/dev/null; then
    NODE_MAJOR=$(node -e 'console.log(process.versions.node.split(".")[0])')
    if [ "$NODE_MAJOR" -ge 22 ]; then return; fi
    echo "  node $NODE_MAJOR found, need >= 22. upgrading..."
  else
    echo "  installing node..."
  fi
  brew install node
}

install_pi() {
  if command -v pi &>/dev/null; then return; fi
  echo "  installing pi..."
  npm install -g @earendil-works/pi-coding-agent
}

# ── Snorrio ──

install_snorrio() {
  # pi install handles: clone, skill registration, extension discovery
  if pi list 2>/dev/null | grep -q snorrio; then
    echo "  package installed, updating..."
    pi update https://github.com/lrhodin/snorrio 2>/dev/null || true
  else
    echo "  installing package..."
    pi install https://github.com/lrhodin/snorrio
  fi
}

create_dirs() {
  mkdir -p "$DATA_HOME"/{episodes,cache/{days,weeks,months,quarters,years},logs,config}
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

  ln -sf "$PACKAGE_DIR/src/recall-engine.ts" "$BIN_DIR/recall"
  chmod +x "$PACKAGE_DIR/src/recall-engine.ts"

  ln -sf "$PACKAGE_DIR/bin/snorrio" "$BIN_DIR/snorrio"
  chmod +x "$PACKAGE_DIR/bin/snorrio"

  ln -sf "$PACKAGE_DIR/skills/subagent/subagent.mjs" "$BIN_DIR/subagent"
  chmod +x "$PACKAGE_DIR/skills/subagent/subagent.mjs"

  cat > "$BIN_DIR/llm" << 'WRAPPER'
#!/bin/bash
SNORRIO=$(dirname "$(readlink "$HOME/.local/bin/recall")")/..
exec node "$SNORRIO/skills/llm-pipe/llm-pipe.ts" "$@"
WRAPPER
  chmod +x "$BIN_DIR/llm"

  echo "  installed CLIs"
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
    <string>${PACKAGE_DIR}/src/episode-daemon.ts</string>
  </array>
  <key>EnvironmentVariables</key>
  <dict>
    <key>HOME</key>
    <string>${HOME}</string>
    <key>PATH</key>
    <string>${BIN_DIR}:${NODE_DIR}:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin</string>
    <key>SNORRIO_HOME</key>
    <string>${DATA_HOME}</string>
  </dict>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${DATA_HOME}/logs/daemon-stdout.log</string>
  <key>StandardErrorPath</key>
  <string>${DATA_HOME}/logs/daemon-stderr.log</string>
</dict>
</plist>
EOF

  launchctl bootout "gui/$(id -u)/io.snorrio.dmn" 2>/dev/null || true
  launchctl bootstrap "gui/$(id -u)" "$PLIST"

  if launchctl list io.snorrio.dmn &>/dev/null; then
    echo "  daemon started"
  else
    echo "  warning: daemon failed to start — check $DATA_HOME/logs/"
  fi
}

install_dev_hooks() {
  # Wire the checked-in pre-commit hook (typecheck) and install dev deps so it runs.
  # Best-effort: skip silently if this isn't a working git checkout.
  if [ ! -d "$PACKAGE_DIR/.git" ]; then return; fi
  if [ ! -f "$PACKAGE_DIR/.githooks/pre-commit" ]; then return; fi

  ( cd "$PACKAGE_DIR" && git config core.hooksPath .githooks ) || return 0

  if [ ! -d "$PACKAGE_DIR/node_modules/typescript" ]; then
    echo "  installing typecheck dev deps..."
    ( cd "$PACKAGE_DIR" && npm install --silent --no-audit --no-fund ) || \
      echo "  warning: npm install failed \u2014 pre-commit hook will skip typecheck until you run npm install"
  fi
  echo "  pre-commit hook installed (typecheck on staged .ts)"
}

ensure_path() {
  if echo "$PATH" | grep -q "$BIN_DIR"; then return; fi

  local shell_rc
  case "${SHELL:-/bin/zsh}" in
    */zsh)  shell_rc="$HOME/.zshrc" ;;
    */bash) shell_rc="$HOME/.bashrc" ;;
    *)      shell_rc="$HOME/.profile" ;;
  esac

  if [ -f "$shell_rc" ] && grep -q '.local/bin' "$shell_rc" 2>/dev/null; then return; fi

  echo '' >> "$shell_rc"
  echo 'export PATH="$HOME/.local/bin:$PATH"' >> "$shell_rc"
  echo "  added ~/.local/bin to PATH in $(basename "$shell_rc")"
}

main "$@"
