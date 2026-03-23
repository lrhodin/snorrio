#!/bin/bash
set -e

HAS_PI=false
HAS_CC=false
command -v pi &>/dev/null && HAS_PI=true
command -v claude &>/dev/null && HAS_CC=true

if ! $HAS_PI && ! $HAS_CC; then
  echo "Neither pi nor Claude Code found. Install one first."
  exit 1
fi

# Install on available platforms
if $HAS_PI; then
  echo "Installing on pi..."
  pi install git:github.com/lrhodin/snorrio
fi

if $HAS_CC; then
  echo "Installing on Claude Code..."
  claude plugin marketplace add https://github.com/lrhodin/snorrio 2>/dev/null || true
  claude plugin install snorrio@snorrio 2>/dev/null || true
fi

# Symlink canonical location — prefer pi if both present
mkdir -p ~/.snorrio
if $HAS_PI && [ -d ~/.pi/agent/git/github.com/lrhodin/snorrio ]; then
  ln -sfn ~/.pi/agent/git/github.com/lrhodin/snorrio ~/.snorrio/src
  echo "Primary: pi ($(readlink ~/.snorrio/src))"
elif $HAS_CC && [ -d ~/.claude/plugins/marketplaces/snorrio ]; then
  ln -sfn ~/.claude/plugins/marketplaces/snorrio ~/.snorrio/src
  echo "Primary: Claude Code ($(readlink ~/.snorrio/src))"
fi

echo ""
echo "Installed. Open pi or claude and mention snorrio to finish setup."
