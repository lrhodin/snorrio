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
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { spawnSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
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

// `snorrio tz set <zone>` mutates an append-only journal, so it is validated
// through the same rules and additionally accepts NO flags: there is nothing an
// unrecognized one could mean. These exercise the real bin/snorrio dispatcher
// against a throwaway SNORRIO_HOME, because the guarantee that matters is not
// "the validator returns help: true" but "the process wrote nothing".
const TZ_SPEC = { allowed: [], positionals: 2 };

test("tz set rejects flags rather than reading one as consent", () => {
  for (const flag of ["--force", "--confirm", "--yes", "-f"]) {
    const r = checkSubcommandArgs("tz", ["set", "America/Los_Angeles", flag], TZ_SPEC);
    assert.equal(r.help, false, flag);
    assert.match(r.error ?? "", /Unknown flag/, flag);
    assert.match(r.error ?? "", /accepts no flags/, flag);
  }
  const ok = checkSubcommandArgs("tz", ["set", "America/Los_Angeles"], TZ_SPEC);
  assert.equal(ok.error, undefined);
  assert.deepEqual(ok.positionals, ["set", "America/Los_Angeles"]);
});

test("tz --help wins over the write, even spelled as `tz set <zone> --help`", () => {
  for (const args of [["--help"], ["-h"], ["set", "America/Los_Angeles", "--help"]]) {
    const r = checkSubcommandArgs("tz", args, TZ_SPEC);
    assert.equal(r.help, true, args.join(" "));
    assert.equal(r.error, undefined);
  }
});

test("bin/snorrio tz --help prints usage and writes no journal", () => {
  const home = mkdtempSync(join(tmpdir(), "snorrio-tz-cli-"));
  const journal = join(home, "config", "tz-history.jsonl");
  try {
    mkdirSync(join(home, "config"), { recursive: true });
    const bin = fileURLToPath(new URL("../bin/snorrio", import.meta.url));
    const env = { ...process.env, SNORRIO_HOME: home };

    // The 2026-08-24 shape exactly: asking for documentation on a writing
    // command. It must print and exit 0 with the journal still absent.
    for (const args of [["tz", "--help"], ["tz", "set", "America/Los_Angeles", "--help"]]) {
      const help = spawnSync("node", [bin, ...args], { encoding: "utf8", env });
      assert.equal(help.status, 0, args.join(" "));
      assert.match(help.stdout, /Usage: snorrio tz/);
      assert.equal(existsSync(journal), false, `${args.join(" ")} must not write`);
    }

    // An unknown flag: exit 2, nothing written.
    const bogus = spawnSync("node", [bin, "tz", "set", "America/Los_Angeles", "--force"], { encoding: "utf8", env });
    assert.equal(bogus.status, 2);
    assert.match(bogus.stderr, /Unknown flag for 'tz': --force/);
    assert.equal(existsSync(journal), false);

    // `set` with no zone: refuses rather than defaulting to the host zone.
    const bare = spawnSync("node", [bin, "tz", "set"], { encoding: "utf8", env });
    assert.equal(bare.status, 2);
    assert.match(bare.stderr, /refusing to guess/i);
    assert.equal(existsSync(journal), false);

    // The read path is safe on an absent journal and still writes nothing.
    const show = spawnSync("node", [bin, "tz"], { encoding: "utf8", env });
    assert.equal(show.status, 0);
    assert.match(show.stdout, /absent/);
    assert.equal(existsSync(journal), false);

    // And the real write does write, once. No episodes here, so there is no
    // pre-journal era to seed — one line, not two.
    const set = spawnSync("node", [bin, "tz", "set", "Europe/Stockholm"], { encoding: "utf8", env });
    assert.equal(set.status, 0, set.stderr);
    const lines = readFileSync(journal, "utf8").trim().split("\n");
    assert.equal(lines.length, 1);
    assert.match(lines[0], /"tz":"Europe\/Stockholm"/);
  } finally { rmSync(home, { recursive: true, force: true }); }
});
