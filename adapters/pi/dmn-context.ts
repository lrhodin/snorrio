// Pi extension — injects snorrio context at session start.
// All logic lives in src/context.ts. This is just the pi glue.

import type { ExtensionAPI } from "@mariozechner/pi-coding-agent";
import { join } from "node:path";

export default function (pi: ExtensionAPI) {
  pi.on("before_agent_start", async (event) => {
    const SNORRIO_HOME = process.env.SNORRIO_HOME || join(process.env.HOME!, "snorrio");
    const { loadContext, getDateRefs } = await import(join(SNORRIO_HOME, "src", "context.ts"));

    let prompt = event.systemPrompt;

    // Fix pi's UTC date with timezone-aware local date
    const { today } = getDateRefs();
    prompt = prompt.replace(/Current date: \d{4}-\d{2}-\d{2}/, `Current date: ${today}`);

    const ctx = loadContext();
    if (ctx) prompt += "\n\n" + ctx + "\n";

    return { systemPrompt: prompt };
  });
}
