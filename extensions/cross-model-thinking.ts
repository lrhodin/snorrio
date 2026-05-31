// Pi extension — makes mid-session `/model` switching safe.
//
// Problem: Anthropic rejects a request (400) when an assistant turn in the
// history carries a `thinking` block that doesn't belong to the current model.
// pi's transform-messages converts foreign thinking to a `text` block, and in
// the trailing/continuation position that reads as a modified thinking block.
// The practical effect today is "stick to one model per session or it breaks."
//
// Fix: before each LLM call, drop thinking blocks from assistant turns produced
// by a *different* model than the one about to run. This runs on the `context`
// hook, which pi hands a `structuredClone` of the messages, so the canonical
// session and on-disk JSONL are never touched — storage stays sacred. Same-model
// thinking is left intact (kept with its valid signature by transform-messages),
// so switching back to the original model fully restores its reasoning. We drop
// rather than convert-to-text because the foreign reasoning is preserved in
// storage and converting-to-text is exactly what trips the 400 here.
//
// The transform itself lives in src/model-independence.ts (single source of
// truth, shared with the recall reader path and unit-tested). This file is glue.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const PKG_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..");

export default function (pi: ExtensionAPI) {
  let dropForeignThinking: ((messages: any[], model: any) => any[]) | null = null;

  pi.on("context", async (event, ctx) => {
    if (!ctx.model) return;
    if (!dropForeignThinking) {
      ({ dropForeignThinking } = await import(join(PKG_ROOT, "src", "model-independence.ts")));
    }
    const messages = dropForeignThinking!(event.messages as any[], ctx.model);
    // Only return a replacement if something actually changed (reference compare).
    if (messages.some((m, i) => m !== (event.messages as any[])[i])) return { messages };
  });
}
