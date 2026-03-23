#!/usr/bin/env node
// CC SessionStart hook — injects snorrio context at session start.
// All logic lives in src/context.ts. This is just the CC glue.

const { loadContext } = await import(new URL("../../src/context.ts", import.meta.url).pathname);
const ctx = loadContext();
if (ctx) console.log(ctx);
