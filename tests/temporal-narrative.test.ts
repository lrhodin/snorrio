import assert from "node:assert/strict";
import test from "node:test";
import {
  normalizeTemporalNarrative,
  prepareTemporalNarrativeSource,
  TEMPORAL_NARRATIVE_INSTRUCTIONS,
  temporalNarrativeViolation,
} from "../src/temporal-narrative.ts";

test("source preparation strips machine frontmatter and renders UTC instants in Pacific time", () => {
  const summer = prepareTemporalNarrativeSource([
    "---",
    'session_id: "01a0400a-92e2-7a0c-bf24-ec393932bcc8"',
    'timestamp: "2026-08-26T22:45:00.649Z"',
    "---",
    "",
    "Started 2026-08-26T22:45:00.649Z.",
  ].join("\n"));
  assert.equal(summer, "\nStarted August 26, 2026 at 3:45 PM PDT.");
  assert.doesNotMatch(summer, /session_id|UTC|Z\b/);

  const winter = prepareTemporalNarrativeSource("At 2026-01-02T07:30:00Z the work finished.");
  assert.equal(winter, "At January 1, 2026 at 11:30 PM PST the work finished.");
});

test("day titles are deterministic Pacific calendar dates", () => {
  assert.equal(
    normalizeTemporalNarrative("day", "2026-08-26", "# Tuesday, August 26, 2026\n\nBody"),
    "# Wednesday, August 26, 2026\n\nBody",
  );
  assert.equal(
    normalizeTemporalNarrative("day", "2026-08-26", "Body"),
    "# Wednesday, August 26, 2026\n\nBody",
  );
});

test("public temporal narrative contract rejects provenance and non-Pacific artifacts", () => {
  assert.match(TEMPORAL_NARRATIVE_INSTRUCTIONS, /America\/Los_Angeles/);
  assert.match(TEMPORAL_NARRATIVE_INSTRUCTIONS, /Never mention provenance/);

  for (const text of [
    "All times below are UTC.",
    "The run ended at 17:38Z.",
    "The run ended at 2026-08-26T17:38:00Z.",
    "Provenance was incomplete.",
    "The lineage could not be established.",
    "The sidecar has a snapshot race.",
    "Session 01a0400a-92e2-7a0c-bf24-ec393932bcc8 did the work.",
  ]) assert.ok(temporalNarrativeViolation(text), text);

  assert.equal(
    temporalNarrativeViolation("PAR-5056 closed at 10:38 AM PT after the policy decision."),
    null,
  );
});
