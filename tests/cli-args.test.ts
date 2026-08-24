// Tests for subcommand flag validation.
//
// The incident these guard: `snorrio migrate-provenance --help` ran the real
// migration on 2026-08-24. The dispatcher matched the subcommand, ignored the
// unrecognized flag, and read dry-run as a separate `includes("--dry-run")`
// check that was simply false — so asking for documentation performed a
// 26-day write. The rules below encode the correction: help wins, and an
// argument we do not recognize stops the command instead of falling through to
// the writing default.

import { test } from "node:test";
import assert from "node:assert/strict";
import { checkSubcommandArgs } from "../src/cli-args.ts";

const MIGRATE = { allowed: ["--dry-run"] };

test("--help never executes the command", () => {
  const r = checkSubcommandArgs("migrate-provenance", ["--help"], MIGRATE);
  assert.equal(r.help, true);
  assert.equal(r.error, undefined);
});

test("-h and bare help are also help", () => {
  for (const flag of ["-h", "help"]) {
    assert.equal(checkSubcommandArgs("migrate-provenance", [flag], MIGRATE).help, true, flag);
  }
});

test("help wins even when combined with a real flag", () => {
  // Otherwise `migrate-provenance --dry-run --help` would run a dry-run the
  // operator did not ask for. Reading docs must never execute anything.
  const r = checkSubcommandArgs("migrate-provenance", ["--dry-run", "--help"], MIGRATE);
  assert.equal(r.help, true);
});

test("an unknown flag is an error, not an ignored argument", () => {
  // The exact 2026-08-24 regression, in the general form: any unrecognized
  // flag must stop the command.
  const r = checkSubcommandArgs("migrate-provenance", ["--dryrun"], MIGRATE);
  assert.equal(r.help, false);
  assert.match(r.error ?? "", /Unknown flag/);
  assert.match(r.error ?? "", /--dryrun/);
  assert.match(r.error ?? "", /--dry-run/); // tells the operator what does exist
});

test("the accepted flag still passes through", () => {
  const r = checkSubcommandArgs("migrate-provenance", ["--dry-run"], MIGRATE);
  assert.equal(r.help, false);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.flags, ["--dry-run"]);
});

test("no arguments is valid", () => {
  const r = checkSubcommandArgs("migrate-provenance", [], MIGRATE);
  assert.equal(r.help, false);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.flags, []);
});

test("a command taking no flags says so", () => {
  const r = checkSubcommandArgs("sweep", ["--force"], { allowed: [] });
  assert.match(r.error ?? "", /accepts no flags/);
});

test("positionals are accepted up to the declared count", () => {
  const spec = { allowed: [], positionals: 2 };
  const r = checkSubcommandArgs("reprocess", ["2026-08-24", "day"], spec);
  assert.equal(r.error, undefined);
  assert.deepEqual(r.positionals, ["2026-08-24", "day"]);
});

test("a surplus positional is rejected rather than silently dropped", () => {
  const spec = { allowed: [], positionals: 2 };
  const r = checkSubcommandArgs("reprocess", ["2026-08-24", "day", "extra"], spec);
  assert.match(r.error ?? "", /Unexpected argument/);
  assert.match(r.error ?? "", /extra/);
});

test("an unknown flag is reported even when it follows valid positionals", () => {
  const spec = { allowed: [], positionals: 2 };
  const r = checkSubcommandArgs("reprocess", ["2026-08-24", "--yolo"], spec);
  assert.match(r.error ?? "", /Unknown flag/);
});
