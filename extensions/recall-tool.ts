// Pi extension — exposes recall as a first-class streaming tool.
//
// The standalone `recall` CLI already streams to a terminal, but invoking it
// through a generic shell tool hides those writes until that tool yields or
// exits. Calling the engine directly lets Pi receive each accumulated text
// update through the tool protocol and repaint it in real time.

import { fileURLToPath } from "node:url";
import type {
  AgentToolUpdateCallback,
  ExtensionAPI,
} from "@earendil-works/pi-coding-agent";
import { Type } from "typebox";

export interface RecallEngine {
  recall(
    target: string,
    question: string,
    modelSpec?: string | null,
    options?: {
      context?: boolean;
      onChunk?: (accumulated: string) => void;
      at?: string;
      signal?: AbortSignal;
    },
  ): Promise<string>;
}

type LoadEngine = () => Promise<RecallEngine>;

type RecallToolDetails = {
  target: string;
  phase?: "loading" | "streaming";
  questionLength?: number;
  answerLength?: number;
  streamed?: boolean;
};

const UPDATE_INTERVAL_MS = 50;

let enginePromise: Promise<RecallEngine> | null = null;

function loadRecallEngine(): Promise<RecallEngine> {
  // Cache the promise, not just the resolved module. Parallel tool calls must
  // share one import even while that import is still in flight.
  if (!enginePromise) {
    const path = fileURLToPath(new URL("../src/recall-engine.ts", import.meta.url));
    enginePromise = import(path) as Promise<RecallEngine>;
  }
  return enginePromise;
}

export function createRecallTool(loadEngine: LoadEngine = loadRecallEngine) {
  return {
    name: "recall",
    label: "Recall",
    description:
      "Query a past session or temporal summary with its original context. Streams the answer into the tool display as it is generated.",
    promptSnippet:
      "Query past sessions and temporal summaries by reviving them with full context",
    promptGuidelines: [
      "Use the recall skill's hierarchy and delegate broad searches to recall-digger; call recall directly only when the target is already known or one hop away.",
      "For recall, use YYYY-MM-DD for a day, YYYY-Www for a week, YYYY-MM for a month, YYYY-QN for a quarter, YYYY for a year, or a session UUID prefix for raw-session detail.",
    ],
    parameters: Type.Object({
      target: Type.String({
        description:
          "Session UUID prefix, .jsonl path, YYYY-MM-DD, YYYY-Www, YYYY-MM, YYYY-QN, or YYYY",
      }),
      question: Type.String({
        description: "The specific question to ask the revived context",
      }),
      context: Type.Optional(
        Type.Boolean({
          description:
            "Situated-witness mode for session recall: include temporal context from when the session ran",
        }),
      ),
      at: Type.Optional(
        Type.String({
          description:
            "ISO timestamp for a historical cache view; supported only for week/month/quarter/year targets",
        }),
      ),
      model: Type.Optional(
        Type.String({
          description:
            "Optional model alias or provider/model-id. Omit to use Snorrio's configured model",
        }),
      ),
    }),

    async execute(
      _toolCallId: string,
      params: {
        target: string;
        question: string;
        context?: boolean;
        at?: string;
        model?: string;
      },
      signal: AbortSignal | undefined,
      onUpdate?: AgentToolUpdateCallback<RecallToolDetails>,
    ) {
      const { target, question, context, at, model } = params;
      const header = `[recall: ${target} — "${question}"]`;

      if (signal?.aborted) throw new Error("Recall cancelled");

      onUpdate?.({
        content: [{ type: "text" as const, text: `Recalling ${target}…` }],
        details: { target, phase: "loading" },
      });

      const engine = await loadEngine();
      if (signal?.aborted) throw new Error("Recall cancelled");

      let lastAccumulated = "";
      let lastPublished = "";
      let lastPublishedAt = 0;
      let updateTimer: NodeJS.Timeout | undefined;

      const publish = () => {
        updateTimer = undefined;
        if (!onUpdate || lastAccumulated === lastPublished || signal?.aborted) return;
        lastPublished = lastAccumulated;
        lastPublishedAt = Date.now();
        onUpdate({
          content: [
            { type: "text" as const, text: `${header}\n\n${lastPublished}` },
          ],
          details: {
            target,
            phase: "streaming",
            answerLength: lastPublished.length,
          },
        });
      };

      const onChunk = onUpdate
        ? (accumulated: string) => {
            lastAccumulated = accumulated;
            if (updateTimer) return;
            const delay = Math.max(0, UPDATE_INTERVAL_MS - (Date.now() - lastPublishedAt));
            if (delay === 0) publish();
            else updateTimer = setTimeout(publish, delay);
          }
        : undefined;

      let answer: string;
      try {
        answer = await engine.recall(target, question, model ?? null, {
          context,
          at,
          onChunk,
          signal,
        });
      } finally {
        if (updateTimer) clearTimeout(updateTimer);
      }

      if (signal?.aborted) throw new Error("Recall cancelled");
      // Flush the newest accumulated text before replacing the partial result
      // with the final tool result.
      publish();
      if (answer.startsWith("[recall: API error")) throw new Error(answer);

      // `answer` is authoritative. `lastAccumulated` exists only to make the
      // streaming/final contract explicit and observable in tests.
      return {
        content: [{ type: "text" as const, text: `${header}\n\n${answer}` }],
        details: {
          target,
          questionLength: question.length,
          answerLength: answer.length,
          streamed: lastAccumulated.length > 0,
        },
      };
    },
  };
}

export default function (pi: ExtensionAPI) {
  pi.registerTool(createRecallTool());
}
