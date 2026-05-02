# Session fixtures

These are real pi session JSONL files copied from `~/.pi/agent/sessions/` and
anonymized for check-in. They exist so `tests/session-meta.test.ts` can exercise
`src/session-meta.ts` against the actual on-disk format pi produces, instead of
hand-rolled toy structures that diverge from reality the moment pi changes
shape.

## Source

Each fixture's filename matches the canonical pi session filename:
`<ISO-timestamp>_<uuid>.jsonl`. The session id (suffix UUID) is what
`sessionIdFromPath` recovers, and what the top-level `{"type":"session", ...}`
entry on line 1 stores in its `id` field.

| File (uuid prefix) | Lines | Top-level `message` count | Notes                                            |
| ------------------ | ----- | ------------------------- | ------------------------------------------------ |
| `43bad035-…`       |     7 |                         4 | Tiny session — the smallest realistic shape.     |
| `7f4c7f73-…`       |    21 |                        16 | Has multiple `model_change` entries.             |
| `019dea9a-…`       |   135 |                       132 | Long session, mixed thinking/tool-use messages.  |
| `af5a9941-…`       |   201 |                       198 | Largest fixture; many assistant turns.           |

All four contain at least one assistant message, so `hasAssistantMessage`
should return `true` for each.

## Anonymization

A small Python pass walked every line and replaced string values with the
literal string `<redacted>` *unless* the key is one of the structural fields
the parser (or any reasonable downstream consumer) needs to keep working:

```
type, role, api, provider, model, modelId, stopReason,
version, thinkingLevel, id, parentId, responseId,
toolUseId, timestamp, name, isError
```

Numbers (timestamps-as-ms, token counts, costs) and booleans pass through
unchanged. The `cwd` field on the session entry is forced to `<redacted>`
because it leaks user paths.

The structural shape — line count, ordering, types, parent/child id graph,
timestamps, `message.role`, content-block `type` values — is preserved exactly.
That is what the parser cares about. The text content is not.

## Maintenance

If pi changes its session format and a fixture stops being representative:

1. Re-copy a fresh real session from `~/.pi/agent/sessions/`.
2. Re-run the same anonymization (preserve-keys list above).
3. Update the table here and any snapshotted counts in
   `tests/session-meta.test.ts`.

Do **not** hand-edit fixtures to make tests pass. If a parser change makes a
fixture fail, the fixture is telling you something.
