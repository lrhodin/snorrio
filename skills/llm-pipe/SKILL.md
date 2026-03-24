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

# Model override
llm "prompt" sonnet
llm "prompt" claude-sonnet-4-6
```

## Flags

- `-t` / `--trusted`: skip injection detection for trusted input (your own code, git diffs, known files)

## Models

Default is whatever's configured in `~/.config/snorrio/config.json`. Don't override it. Override with second argument only if the user asks:
- `haiku`, `sonnet`, `opus` — aliases
- `provider/model-id` — explicit

## CLI Setup

`llm` is on PATH (`~/.local/bin/llm`). Always use it directly — never run the source file.

## Context discipline

Use `llm` aggressively to keep agent context clean. Every snapshot, log, diff, or command output is a candidate:

```bash
agent-browser snapshot -c | llm "list article titles and URLs"
git log --oneline -20 | llm "what changed this week"
cat log.txt | llm "anything wrong? one word"
```
