#!/usr/bin/env node
import { pathToFileURL } from 'node:url';

const object = value => value !== null && typeof value === 'object' && !Array.isArray(value);
const text = value => typeof value === 'string' && value.trim().length > 0;
const only = (value, keys) => Object.keys(value).every(key => keys.includes(key));

// Deliberately supports only boolean and choice questions, not every SDK feature.
export function validate(input) {
  if (!object(input) || !only(input, ['state', 'questions']) ||
      !Object.hasOwn(input, 'state') ||
      !(typeof input.state === 'string' || object(input.state) || Array.isArray(input.state)) ||
      !object(input.questions) || !Object.keys(input.questions).length) {
    throw new Error('Expected {state, questions} with string/object/array state and nonempty questions.');
  }
  for (const [id, q] of Object.entries(input.questions)) {
    if (!text(id) || !object(q) || !text(q.instructions) ||
        !['boolean', 'choice'].includes(q.type) ||
        !only(q, q.type === 'choice' ? ['type', 'instructions', 'criteria'] : ['type', 'instructions'])) {
      throw new Error('Each question needs an ID, boolean/choice type and nonempty instructions.');
    }
    if (q.type === 'choice' && (!object(q.criteria) || Object.keys(q.criteria).length < 2 ||
        !Object.entries(q.criteria).every(([key, value]) => text(key) && text(value)))) {
      throw new Error('Choice criteria must map at least two nonempty labels to descriptions.');
    }
  }
  return input;
}

export async function run(input, evaluate) {
  validate(input);
  const result = await evaluate({ model: 'typesafe-ai/jev', ...input,
    maxRetries: 0, abortSignal: AbortSignal.timeout(60_000) });
  // Do not print response headers, provider metadata, request state or credentials.
  return { answers: result.answers, usage: result.usage, rounding: result.rounding };
}

export async function main(stdin = process.stdin, stdout = process.stdout, stderr = process.stderr) {
  let input;
  try {
    stdin.setEncoding?.('utf8');
    let raw = '';
    let bytes = 0;
    for await (const chunk of stdin) {
      bytes += Buffer.byteLength(chunk);
      if (bytes > 1_048_576) throw new Error('Input exceeds 1 MiB.');
      raw += chunk;
    }
    try { input = JSON.parse(raw); } catch { throw new Error('stdin must contain one JSON document.'); }
    validate(input);
  } catch (error) {
    stderr.write(JSON.stringify({ error: error.message }) + '\n');
    return 1;
  }
  if (!process.env.AI_GATEWAY_API_KEY?.trim()) {
    stderr.write(JSON.stringify({ error: 'Set AI_GATEWAY_API_KEY to a Vercel AI Gateway API key (not a management token).' }) + '\n');
    return 1;
  }
  try {
    globalThis.AI_SDK_LOG_WARNINGS = false;
    const { experimental_evaluate } = await import('ai');
    stdout.write(JSON.stringify(await run(input, experimental_evaluate)) + '\n');
    return 0;
  } catch {
    // SDK errors can contain request bodies/headers. Never echo them.
    stderr.write(JSON.stringify({ error: 'Jev evaluation failed. Check skill dependencies, Gateway access/credits and connectivity. No provider details logged.' }) + '\n');
    return 1;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  process.exitCode = await main();
}
