// Pi extension — injects snorrio context at session start.
// All logic lives in src/context.ts. This is just the pi glue.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const { loadContext } = await import(new URL("../../src/context.ts", import.meta.url).pathname);
    const ctx = loadContext();
    if (!ctx) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + ctx + "\n" };
  });
}
