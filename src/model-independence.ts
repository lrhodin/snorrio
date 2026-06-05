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

import type { Message } from "./ai.ts";

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

// --- Session control-message normalization ---
//
// pi's buildSessionContext() yields, alongside ordinary user/assistant turns, a
// handful of session-bookkeeping "control" messages: bash escapes (the `!cmd`
// shell prompt, NOT the Bash tool), branch summaries, compaction summaries, and
// extension-injected custom messages. They carry non-conversational roles
// ("bashExecution", "branchSummary", "compactionSummary", "custom"), and the
// summary/bash kinds have NO `content` field at all — so they are not valid LLM
// messages and must not reach a provider as-is (their roles aren't understood and
// they'd send empty content). This path runs only at recall + DMN read time,
// never live, so snorrio owns the editorial choice of how to present this
// bookkeeping to a reader model. We do it structurally (matched on role + fields)
// without importing pi's types or its convertToLlm() — same decoupling stance as
// the rest of this file and ai.ts: pi is a runtime-global, untyped dependency.

// The real conversational roles pi emits for LLM messages. These are
// `pi-ai`'s `Message` union discriminants (UserMessage | AssistantMessage |
// ToolResultMessage) and MUST flow through to the provider untouched — they
// carry tool-call linkage (toolCallId / tool_use_id) and provider/api/model.
export const CONVERSATIONAL_ROLES = new Set(["user", "assistant", "toolResult"]);

// pi's session-bookkeeping "control" roles that snorrio knows how to convert to
// readable text. These are the keys pi declaration-merges into `CustomAgentMessages`
// (see pi-coding-agent `dist/core/messages.d.ts`).
export const CONTROL_ROLES = new Set(["bashExecution", "branchSummary", "compactionSummary", "custom"]);

// SINGLE SOURCE OF TRUTH: every session role snorrio knows how to handle =
// the conversational allowlist + the known control roles. The runtime
// allowlist-flip in normalizeSessionMessages() and the build-time d.ts canary
// (tests/pi-role-surface.test.ts) both consume THIS const so they can't drift.
// Any role pi can emit that is NOT in here is an unknown role: the canary fails
// at build time, and the runtime fails safe (never forwards it raw).
export const KNOWN_PI_ROLES: ReadonlySet<string> = new Set([...CONVERSATIONAL_ROLES, ...CONTROL_ROLES]);

// Warn at most once per distinct unknown role. Module-level so the dedupe spans
// every normalizeSessionMessages() call in the process (recall + DMN read paths).
const _warnedRoles = new Set<string>();

/**
 * Emit a one-time stderr warning for a session role snorrio doesn't know how to
 * handle. stderr (not stdout) so it surfaces both in the recall CLI and in the
 * episode-daemon log without polluting captured stdout. Deduped per distinct
 * role — a session full of an unknown role warns once, not once per message.
 */
function warnOncePerRole(role: string): void {
  if (_warnedRoles.has(role)) return;
  _warnedRoles.add(role);
  process.stderr.write(
    `snorrio: unknown session role '${role}' — update normalizeSessionMessages/KNOWN_PI_ROLES\n`,
  );
}

// snorrio's own framing of pi's summary bookkeeping (deliberately not pi's wire
// constants — we don't couple to pi strings, we choose how to present them).
const BRANCH_SUMMARY_LABEL = "[summary of a branch this conversation returned from]";
const COMPACTION_SUMMARY_LABEL = "[summary of earlier conversation history that was compacted]";

// The raw, loose shape pi hands us at the buildSessionContext() boundary. Index
// signature lets the normalizer read control-message fields (.summary, .command)
// that the strict Message type doesn't carry.
export type RawSessionMessage = { role?: string; content?: unknown; timestamp?: number; [k: string]: unknown };

function contentToText(content: unknown): string {
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((b: any) => (typeof b?.text === "string" ? b.text : ""))
      .filter(Boolean)
      .join("\n");
  }
  return "";
}

/**
 * Narrow pi's raw session messages (the AgentMessage union, handled
 * structurally) to strict snorrio Messages fit for an LLM. Ordinary turns pass
 * through; control messages are converted to readable user-text or dropped per
 * snorrio's editorial choice. Every emitted message carries content, so the
 * downstream `Message.content` contract is honestly required (no paper-over).
 *
 * Editorial choices (Ludvig, 2026-06-03): branch/compaction summaries are the
 * model's own summary of dropped context — genuine recall signal — so CONVERT
 * them to readable text. Bash escapes are noisy and rare; honor pi's
 * `excludeFromContext` (the `!!` hide flag) and otherwise render compactly.
 */
export function normalizeSessionMessages(messages: RawSessionMessage[]): Message[] {
  const out: Message[] = [];
  for (const m of messages) {
    const role = m.role;

    // (1) Conversational turn (or a message with no role at all): spread the
    // ORIGINAL through unchanged so all top-level fields survive — tool-call
    // linkage (toolCallId / tool_use_id; dropping the latter caused the 47251a1
    // provider 400), plus provider/api/model that downstream thinking transforms
    // read. Only fill role/content so the strict Message contract holds.
    if (!role || CONVERSATIONAL_ROLES.has(role)) {
      out.push({ ...m, role: role ?? "user", content: (m.content ?? "") as string | any[] });
      continue;
    }

    // (2) Known control/bookkeeping role: convert to readable user text.
    if (CONTROL_ROLES.has(role)) {
      // Honor pi's hide flag uniformly across ALL control kinds (redteam flagged
      // that `custom` ignored what `bashExecution` honored). `!!`-hidden bash
      // escapes and any other excluded control message are dropped consistently.
      if (m.excludeFromContext) continue;
      if (role === "bashExecution") {
        const command = typeof m.command === "string" ? m.command : "";
        const output = typeof m.output === "string" ? m.output : "";
        const text = `$ ${command}${output ? `\n${output}` : ""}`.trim();
        if (text) out.push({ role: "user", content: text, timestamp: m.timestamp });
        continue;
      }
      if (role === "branchSummary" || role === "compactionSummary") {
        const summary = typeof m.summary === "string" ? m.summary.trim() : "";
        if (!summary) continue;
        const label = role === "branchSummary" ? BRANCH_SUMMARY_LABEL : COMPACTION_SUMMARY_LABEL;
        out.push({ role: "user", content: `${label}\n${summary}`, timestamp: m.timestamp });
        continue;
      }
      // role === "custom": extension-injected; keep its real content if present.
      const customText = contentToText(m.content);
      if (customText) out.push({ role: "user", content: customText, timestamp: m.timestamp });
      continue;
    }

    // (3) UNKNOWN role — the allowlist-flip's fail-safe default. snorrio does NOT
    // forward a role it doesn't understand to a provider: a future pi control
    // role could carry no `content` (=> provider 400) or non-conversational junk.
    // Warn once, then salvage any readable text as a plain user turn or drop it.
    warnOncePerRole(role);
    const unknownText = contentToText(m.content);
    if (unknownText) out.push({ role: "user", content: unknownText, timestamp: m.timestamp });
  }
  return out;
}

/**
 * The single transform applied to pi's buildSessionContext() messages before
 * they reach complete()/stream(): narrow control messages to LLM-fit user text,
 * then render thinking blocks readably. This is snorrio's owned session-read
 * boundary — the seam that turns pi's raw AgentMessage[] into strict Message[].
 */
export function sessionMessagesToLlm(messages: RawSessionMessage[]): Message[] {
  return toReadableThinking(normalizeSessionMessages(messages));
}
