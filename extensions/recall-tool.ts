// recall-tool.ts — pi extension that provides recall as a tool.
//
// For agents that need recall in their toolbelt.
// Calls recall-engine directly as a module — no subprocess.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { Type } from "@sinclair/typebox";

export default function (pi: ExtensionAPI) {
  let _engine: any;
  async function getEngine() {
    if (!_engine) {
      const path = new URL("../src/recall-engine.mjs", import.meta.url).pathname;
      _engine = await import(path);
    }
    return _engine;
  }

  pi.registerTool({
    name: "recall",
    label: "Recall",
    description:
      "Revive a past session or temporal agent and ask it a question. The target is thawed with its full original context and answers from first-person experience.",
    promptSnippet:
      "Query past sessions and temporal agents by reviving them with full context",
    promptGuidelines: [
      "Start at the right level: week agent for 'which day?', day agent for 'which session?', raw session for verbatim detail.",
      "Drill down by asking higher-level agents to NAME the subordinate that has the detail, then recall that subordinate directly.",
      "Example: recall W09 → 'that was on March 6th' → recall 2026-03-06 → 'session 50690a64' → recall 50690a64 for exact details.",
      "For day agents, use YYYY-MM-DD (e.g., '2026-03-05'). For week agents, use YYYY-Www (e.g., '2026-W09').",
      "For raw sessions, use the UUID prefix from episode headers.",
      "Each recall is ~1-2s. Three hops to verbatim detail in under 5 seconds.",
      "You can make multiple recall calls in parallel for broad context or verification.",
    ],
    parameters: Type.Object({
      target: Type.String({
        description:
          "Session ID (UUID prefix), agent date (YYYY-MM-DD), week (YYYY-Www), month (YYYY-MM), quarter (YYYY-QN), or full path to .jsonl",
      }),
      question: Type.String({
        description: "The question to ask the revived session or agent",
      }),
    }),

    async execute(toolCallId, params, signal, onUpdate) {
      const { target, question } = params;

      onUpdate?.({
        content: [
          { type: "text" as const, text: `Recalling ${target}: "${question}"` },
        ],
      });

      try {
        const engine = await getEngine();
        const answer = await engine.recall(target, question);
        return {
          content: [{ type: "text" as const, text: answer }],
          details: {
            target,
            questionLength: question.length,
            answerLength: answer.length,
          },
        };
      } catch (err: any) {
        return {
          content: [
            {
              type: "text" as const,
              text: `Recall failed: ${err.message?.slice(0, 300)}`,
            },
          ],
          details: { error: "failed", target },
          isError: true,
        };
      }
    },
  });
}
