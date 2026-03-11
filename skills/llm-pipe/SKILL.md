---
name: llm-pipe
description: Shell primitive that pipes stdin through an LLM. Zero-cost via pi's OAuth. Use it to keep your context clean — pipe tool output through it instead of reading raw output yourself.
---

# LLM Pipe

**`llm "prompt"`** — pipes stdin through Claude, writes result to stdout.

## Usage

```bash
# Basic — pipe anything through an LLM
cmd | llm "summarize this"
llm "what day is it"

# Trusted mode — skip injection detection for your own code/files
cat source.py | llm -t "explain this"
git diff | llm -t "one sentence summary"

# Model override (default: haiku)
llm "prompt" sonnet
llm "prompt" claude-sonnet-4-6
```

## Flags

- `-t` / `--trusted`: skip injection detection for trusted input (your own code, git diffs, known files)

## Models

Default is Haiku (~1s simple, ~3-5s large input). Override with second argument:
- `haiku`, `sonnet`, `opus` — aliases
- `provider/model-id` — explicit (e.g., `github-copilot/claude-haiku-4.5`)

**Model choice:** Haiku for triage/filtering. Sonnet for extraction/summarization. Opus only for publication-ready prose.

## CLI Setup

The skill includes `llm-pipe.mjs` in this directory. To use as `llm` from the shell:

```bash
cat > /usr/local/bin/llm << 'EOF'
#!/bin/bash
SKILL_DIR="$(dirname "$(readlink -f "$0")")/../.pi/agent/git/github.com/lrhodin/snorrio/skills/llm-pipe"
# Fallback: find via pi's package directory
if [ ! -f "$SKILL_DIR/llm-pipe.mjs" ]; then
  SKILL_DIR="$(find ~/.pi/agent/git -path "*/snorrio/skills/llm-pipe" -type d 2>/dev/null | head -1)"
fi
NODE_PATH=$(npm root -g)/@mariozechner/pi-coding-agent/node_modules \
  exec node "$SKILL_DIR/llm-pipe.mjs" "$@"
EOF
chmod +x /usr/local/bin/llm
```

## Context discipline

Use `llm` aggressively to keep agent context clean. Every snapshot, log, diff, or command output is a candidate:

```bash
agent-browser snapshot -c | llm "list article titles and URLs"
git log --oneline -20 | llm "what changed this week"
cat log.txt | llm "anything wrong? one word"
```
