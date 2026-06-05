// Build-time canary: detect a NEW pi control role before it reaches runtime.
//
// snorrio's normalizeSessionMessages() is an allowlist (KNOWN_PI_ROLES): real
// conversational roles pass through, known control roles are converted, and an
// UNKNOWN role fails safe. This canary closes the loop at build time — it reads
// pi's *shipped* .d.ts as DATA (never an `import type`, preserving the deliberate
// decoupling: "we don't own pi's types") and asserts that every role pi can emit
// is already in KNOWN_PI_ROLES. If pi adds a control role snorrio doesn't handle,
// this fails loudly here instead of silently degrading recall at runtime.
//
// Where pi's role union lives (inspected, not hard-coded blindly):
//   - Base LLM roles: pi-ai `dist/types.d.ts` —
//       `type Message = UserMessage | AssistantMessage | ToolResultMessage`
//     each member an interface with a `role: "user" | "assistant" | "toolResult"`
//     string-literal discriminant.
//   - Control roles: pi-coding-agent `dist/core/messages.d.ts` — interfaces with
//     `role: "bashExecution" | "custom" | "branchSummary" | "compactionSummary"`,
//     registered into the AgentMessage union via a declaration-merge:
//       `declare module "@earendil-works/pi-agent-core" {
//          interface CustomAgentMessages { bashExecution: ...; custom: ...; ... } }`
//
// So pi's full emittable role set = every `role: "<lit>"` discriminant in its
// d.ts, which scans cleanly to exactly those 7 literals with no pollution. We
// also union in the KEYS of every `interface CustomAgentMessages { ... }` block
// (pi's explicit control-role registry) as a belt-and-suspenders signal.

import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync, readdirSync, statSync, existsSync } from "node:fs";
import { join } from "node:path";
import { piRoot } from "../src/ai.ts";
import { KNOWN_PI_ROLES } from "../src/model-independence.ts";

// Recursively collect .d.ts files under a directory (bounded to pi's own pkgs).
function collectDts(dir: string, acc: string[] = []): string[] {
  let entries: string[];
  try { entries = readdirSync(dir); } catch { return acc; }
  for (const name of entries) {
    const p = join(dir, name);
    let s;
    try { s = statSync(p); } catch { continue; }
    if (s.isDirectory()) collectDts(p, acc);
    else if (name.endsWith(".d.ts")) acc.push(p);
  }
  return acc;
}

// The pi directories that define message/role types. We scan pi's own shipped
// dist + the @earendil-works scoped packages it bundles (pi-ai, pi-agent-core).
function piDtsFiles(root: string): string[] {
  const roots = [join(root, "dist"), join(root, "node_modules", "@earendil-works")];
  const files: string[] = [];
  for (const r of roots) if (existsSync(r)) collectDts(r, files);
  return files;
}

// Strip comments so the extractor only sees real declarations, never JSDoc
// `@example` blocks. pi's d.ts documents the extension mechanism with fenced
// examples that mention illustrative roles (e.g. `artifact`, `notification`)
// that pi does NOT actually emit — scanning those would be a false positive that
// silently inflates the "pi can emit" set. Block comments first (covers JSDoc),
// then line comments.
function stripComments(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/[^\n]*/g, "");
}

function extractPiRoles(files: string[]): Set<string> {
  const roles = new Set<string>();
  for (const f of files) {
    const src = stripComments(readFileSync(f, "utf8"));
    // (a) string-literal role discriminants on message interfaces.
    for (const m of src.matchAll(/\brole:\s*"([^"]+)"/g)) roles.add(m[1]);
    // (b) keys of every (non-empty) CustomAgentMessages augmentation block —
    // pi's explicit control-role registry (the declaration-merge target).
    for (const blk of src.matchAll(/interface\s+CustomAgentMessages\s*\{([^}]*)\}/g)) {
      for (const k of blk[1].matchAll(/(\w+)\s*:/g)) roles.add(k[1]);
    }
  }
  return roles;
}

test("pi-role-surface canary: pi's emittable role set is a subset of KNOWN_PI_ROLES", () => {
  const root = piRoot();
  if (!root) {
    // A machine without pi installed shouldn't break the suite. Skip, don't fail.
    console.log("[skip] pi not installed (piRoot() === null) — canary inert");
    return;
  }

  const files = piDtsFiles(root);
  assert.ok(files.length > 0, `no .d.ts files found under pi root ${root} — canary cannot run`);

  const piRoles = extractPiRoles(files);

  // Guard against a brittle parser that silently never fires: if pi's d.ts shape
  // changed such that we no longer recognize the well-known base roles, the
  // extractor is broken and the canary would be falsely green. Fail loudly.
  for (const base of ["user", "assistant", "toolResult"]) {
    assert.ok(
      piRoles.has(base),
      `canary parser found ${piRoles.size} roles but is missing base role '${base}'. ` +
        `pi's d.ts role shape likely changed — update extractPiRoles() in this test ` +
        `(see pi-ai dist/types.d.ts Message union + pi-coding-agent dist/core/messages.d.ts).`,
    );
  }

  // The actual assertion: nothing pi can emit is unknown to snorrio.
  const unknown = [...piRoles].filter((r) => !KNOWN_PI_ROLES.has(r)).sort();
  assert.equal(
    unknown.length,
    0,
    `pi can emit session role(s) snorrio does not handle: ${JSON.stringify(unknown)}. ` +
      `Add handling in normalizeSessionMessages() and the role to KNOWN_PI_ROLES ` +
      `(src/model-independence.ts). Roles seen in pi's d.ts: ${JSON.stringify([...piRoles].sort())}.`,
  );
});
