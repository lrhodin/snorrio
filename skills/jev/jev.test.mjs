import test from 'node:test';
import assert from 'node:assert/strict';
import { Readable } from 'node:stream';
import { validate, run, main } from './jev.mjs';
const valid = () => ({ state: { evidence: 'synthetic' }, questions: {
  yes: { type: 'boolean', instructions: 'Is evidence present?' },
  route: { type: 'choice', instructions: 'Classify.', criteria: { a: 'A', unknown: 'Missing evidence' } }
} });
test('valid boolean and choice input', () => assert.equal(validate(valid()).questions.yes.type, 'boolean'));
test('reject invalid shapes and override attempts', () => {
  for (const value of [null, [], {}, { ...valid(), model: 'other' },
    { ...valid(), state: null }, { ...valid(), state: 123 }, { ...valid(), state: true },
    { ...valid(), questions: {} },
    { ...valid(), questions: { q: { type: 'score', instructions: 'x' } } },
    { ...valid(), questions: { q: { type: 'boolean', instructions: '' } } },
    { ...valid(), questions: { q: { type: 'choice', instructions: 'x', criteria: { a: 'A' } } } },
    { ...valid(), questions: { q: { type: 'choice', instructions: 'x', criteria: { a: 'A', b: 1 } } } }
  ]) assert.throws(() => validate(value));
});
test('fixed evaluation model and bounded request, clean output', async () => {
  const result = await run(valid(), async options => {
    assert.equal(options.model, 'typesafe-ai/jev');
    assert.equal(options.maxRetries, 0);
    assert.ok(options.abortSignal instanceof AbortSignal);
    return { answers: { yes: { type: 'boolean', probability: 0.8 } }, usage: { totalTokens: 10 },
      rounding: undefined, response: { headers: { authorization: 'secret' } } };
  });
  assert.equal(result.answers.yes.probability, 0.8);
  assert.ok(!JSON.stringify(result).includes('secret'));
});
test('CLI invalid JSON and oversized input do not echo contents', async () => {
  for (const raw of ['private invalid content', 'x'.repeat(1_048_577)]) {
    let out = '', err = '';
    const code = await main(Readable.from([raw]), { write: s => out += s }, { write: s => err += s });
    assert.equal(code, 1); assert.equal(out, ''); assert.ok(!err.includes('private'));
    assert.ok(JSON.parse(err).error);
  }
});
test('missing key fails clearly without making a request', async () => {
  const key = process.env.AI_GATEWAY_API_KEY;
  delete process.env.AI_GATEWAY_API_KEY;
  try {
    let err = '';
    assert.equal(await main(Readable.from([JSON.stringify(valid())]), { write: () => assert.fail() },
      { write: s => err += s }), 1);
    assert.match(err, /AI_GATEWAY_API_KEY/);
  } finally {
    if (key !== undefined) process.env.AI_GATEWAY_API_KEY = key;
  }
});
