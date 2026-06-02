// Model-independence transforms for snorrio.
//
// A `thinking` block produced by a model carries a model- and time-specific
// signature (`thinkingSignature`) that Anthropic validates and rejects when it
// reappears in a context it didn't originate in. This is what makes both
// session-level recall (reading a session with a different/same model) and
// mid-session `/model` switching fail with a 400.
//
// There are two distinct situations, with two correct answers:
//
//   1. RECALL — a reader model reads a past session as reference material.
//      The reasoning IS source material the reader should see, and the foreign
//      turn is always historical (a fresh user question follows it), never the
//      trailing turn being continued. So CONVERT thinking -> readable text.
//
//   2. LIVE /model SWITCH — the session continues on a new model.
//      The foreign turn may be the trailing/continuation turn, where converting
//      to text trips the 400. The original reasoning is preserved in storage and
//      restored verbatim when you switch back to its model. So DROP it on the
//      wire.
//
// Redacted (encrypted) thinking has no readable content; drop it in both cases.

export const THINKING_TYPES = new Set(["thinking", "redacted_thinking"]);

type Block = { type?: string; thinking?: string; [k: string]: unknown };
// Structural constraint for the message-shaped objects these helpers operate on.
// Intentionally loose (all fields optional) so callers can pass concrete, closed
// message types (e.g. ai.ts `Message`) and get the same element type back. No
// index signature: requiring one would reject closed object types as type args.
type Msg = { role?: string; content?: unknown; provider?: string; api?: string; model?: string };

/**
 * RECALL: render thinking as readable, labeled text so any reader model can
 * read any session faithfully. Drops the signature (the text block is fresh),
 * preserves the reasoning content, drops redacted thinking.
 */
export function toReadableThinking<T extends Msg>(messages: T[]): T[] {
  return messages.map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
    const content = (m.content as Block[]).flatMap((block) => {
      if (block?.type === "redacted_thinking") return [];
      if (block?.type === "thinking") {
        const text = (block.thinking ?? "").trim();
        return text ? [{ type: "text", text: `<thinking>\n${text}\n</thinking>` }] : [];
      }
      return [block];
    });
    return { ...m, content };
  });
}

/**
 * LIVE SWITCH: drop thinking blocks from assistant turns produced by a model
 * other than `model`. Same-model thinking is left intact (transform-messages
 * keeps it with its valid signature). Pure: operates on its input only.
 */
export function dropForeignThinking<T extends Msg>(
  messages: T[],
  model: { id?: string; provider?: string; api?: string } | undefined,
): T[] {
  if (!model) return messages;
  return messages.map((m) => {
    if (m.role !== "assistant" || !Array.isArray(m.content)) return m;
    const sameModel = m.provider === model.provider && m.api === model.api && m.model === model.id;
    if (sameModel) return m;
    const content = m.content as Block[];
    if (!content.some((b) => THINKING_TYPES.has(b?.type as string))) return m;
    return { ...m, content: content.filter((b) => !THINKING_TYPES.has(b?.type as string)) };
  });
}
