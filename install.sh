#!/usr/bin/env bash
# snorrio install/update
# curl -fsSL https://snorr.io/install | bash
set -euo pipefail

# Colors (disabled if not a terminal)
if [ -t 1 ]; then
  dim='\033[2m'
  reset='\033[0m'
  bold='\033[1m'
else
  dim='' reset='' bold=''
fi

step() { printf "${dim}%s${reset}\n" "$1"; }
done_msg() { printf "${bold}%s${reset}\n" "$1"; }

# --- Node.js ---
if ! command -v node &>/dev/null; then
  step "installing node..."
  if command -v brew &>/dev/null; then
    brew install node
  elif command -v apt-get &>/dev/null; then
    curl -fsSL https://deb.nodesource.com/setup_lts.x | sudo -E bash -
    sudo apt-get install -y nodejs
  else
    echo "error: node.js not found. install it from https://nodejs.org" >&2
    exit 1
  fi
fi

# --- pi ---
step "installing pi..."
npm install -g @mariozechner/pi-coding-agent

# --- snorrio ---
step "installing snorrio..."
pi install git:github.com/lrhodin/snorrio

echo
done_msg "ready. type: pi"
