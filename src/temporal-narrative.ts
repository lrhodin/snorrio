// Human-facing temporal memory is prose, not an audit report. Structural
// provenance remains in the input and sidecars so the synthesizer can avoid
// double-counting, but none of that machinery belongs in the narrative.

export const TEMPORAL_NARRATIVE_INSTRUCTIONS = `

Write only the human narrative. Provenance metadata is private reasoning context: use it silently to avoid treating a parent, child, or repeated account as independent corroboration. A missing structural link does not prove that two accounts are independent. Never mention provenance, lineage, evidence sources, families, provenance manifests, coverage, source counts, session IDs, or the mechanics of the context. Do not include provenance caveats or provenance sections. Do not narrate, quote, or explain work on the memory system's provenance or time-rendering machinery even if it appears in the source; at most say the daily cache presentation was corrected. If the underlying facts are uncertain, state only the factual uncertainty that matters to the story.

Render every human-facing clock time in Pacific time using America/Los_Angeles. Convert source timestamps before writing. Use PT when a timezone label is useful. Never print UTC, a Z-suffixed time, a numeric UTC offset, or a raw ISO timestamp.`;

const PACIFIC_FORMAT = new Intl.DateTimeFormat("en-US", {
  timeZone: "America/Los_Angeles",
  year: "numeric",
  month: "long",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
  timeZoneName: "short",
});
const ISO_UTC_INSTANT = /\b\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b/g;

/** Remove machine metadata and convert canonical instants before model exposure. */
export function prepareTemporalNarrativeSource(text: string): string {
  const withoutFrontmatter = text.startsWith("---\n")
    ? text.replace(/^---\n[\s\S]*?\n---\n?/, "")
    : text;
  return withoutFrontmatter
    .replace(ISO_UTC_INSTANT, (raw) => PACIFIC_FORMAT.format(new Date(raw)))
    .replace(/\bUTC\b/g, "non-Pacific time");
}

const SESSION_ID = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|01[a-z0-9]{6,})\b/i;
const UTC_TIME = /(?:\bUTC\b|\d{4}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b|\b\d{1,2}:\d{2}(?::\d{2}(?:\.\d+)?)?Z\b)/i;
const PROVENANCE_LANGUAGE = /\b(?:provenance|lineage|evidence source|source groups?|provenance famil(?:y|ies)|provenance manifest|session IDs?|coverage incomplete|independent corroboration|internal bookkeeping|source mechanics|sidecars?|snapshot race|cascade coordinator|drill(?:ing)? (?:down|into))\b/i;

export function normalizeTemporalNarrative(level: string, ref: string, text: string): string {
  if (level !== "day" || !/^\d{4}-\d{2}-\d{2}$/.test(ref)) return text;
  const date = new Date(`${ref}T12:00:00Z`);
  const title = new Intl.DateTimeFormat("en-US", {
    timeZone: "America/Los_Angeles",
    weekday: "long",
    year: "numeric",
    month: "long",
    day: "numeric",
  }).format(date);
  return text.match(/^# .+$/m)
    ? text.replace(/^# .+$/m, `# ${title}`)
    : `# ${title}\n\n${text}`;
}

/** Return a reason when text violates the public temporal-cache contract. */
export function temporalNarrativeViolation(text: string): string | null {
  if (UTC_TIME.test(text)) return "contains a UTC or Z-suffixed timestamp";
  if (SESSION_ID.test(text)) return "contains an internal session identifier";
  if (PROVENANCE_LANGUAGE.test(text)) return "exposes provenance machinery";
  return null;
}
