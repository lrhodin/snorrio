// Pi extension — injects snorrio context at session start.
// All logic lives in src/context.ts. This is just the pi glue.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const SNORRIO_HOME = process.env.SNORRIO_HOME || join(process.env.HOME!, "snorrio");
    const { loadContext } = await import(join(SNORRIO_HOME, "src", "context.ts"));
    const ctx = loadContext();
    if (!ctx) return;
    return { systemPrompt: event.systemPrompt + "\n\n" + ctx + "\n" };
  });
}
