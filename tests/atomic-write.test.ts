// Atomicity invariant for episode-daemon's cache writes.
//
// The daemon's banner says: "All writes are atomic (tmp + rename). No gap
// where cache is missing." This test pins that down for atomicWriteFile,
// the helper used for every day/week/month/quarter/year cache write and
// for episode rewrites in --reprocess.
//
// What we assert:
//   1. If the rename step fails, the function throws.
//   2. The pre-existing destination file is unchanged byte-for-byte.
//   3. No <path>.tmp file is left behind.
//   4. A subsequent successful write replaces the destination cleanly,
//      again with no .tmp residue.

import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, writeFileSync, readFileSync, existsSync, readdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";

import { atomicWriteFile, _io } from "../src/atomic-write.ts";

function makeTempDir(): string {
  return mkdtempSync(join(tmpdir(), "snorrio-atomic-"));
}

test("atomicWriteFile: rename failure leaves old content intact and removes .tmp", () => {
  const dir = makeTempDir();
  try {
    const dest = join(dir, "cache.md");
    const OLD = "OLD CONTENT — must survive a failed write\n";
    const NEW = "NEW CONTENT — never lands\n";
    writeFileSync(dest, OLD, "utf8");

    const realRename = _io.renameSync;
    let renameCalls = 0;
    _io.renameSync = ((from: string, to: string) => {
      renameCalls++;
      if (to === dest) {
        throw new Error("simulated rename failure (e.g. ENOSPC, EXDEV)");
      }
      return realRename(from, to);
    }) as typeof _io.renameSync;

    try {
      assert.throws(
        () => atomicWriteFile(dest, NEW),
        /simulated rename failure/,
        "atomicWriteFile must surface the rename failure",
      );
    } finally {
      _io.renameSync = realRename;
    }

    assert.equal(renameCalls, 1, "rename should have been attempted exactly once");

    assert.equal(
      readFileSync(dest, "utf8"),
      OLD,
      "destination must still contain the old content byte-for-byte",
    );

    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(
      leftovers,
      [],
      `no .tmp files should remain after a failed write; found: ${leftovers.join(", ")}`,
    );
    assert.equal(existsSync(dest + ".tmp"), false, "specific tmp path must not exist");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteFile: successful write replaces destination and leaves no .tmp", () => {
  const dir = makeTempDir();
  try {
    const dest = join(dir, "cache.md");
    const OLD = "OLD CONTENT\n";
    const NEW = "NEW CONTENT\n";
    writeFileSync(dest, OLD, "utf8");

    atomicWriteFile(dest, NEW);

    assert.equal(readFileSync(dest, "utf8"), NEW, "destination should hold new content");
    assert.equal(existsSync(dest + ".tmp"), false, "no tmp file should remain");
    const leftovers = readdirSync(dir).filter((f) => f.endsWith(".tmp"));
    assert.deepEqual(leftovers, [], "directory should have no .tmp residue");
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("atomicWriteFile: creating a brand-new file works and leaves no .tmp", () => {
  const dir = makeTempDir();
  try {
    const dest = join(dir, "nested", "deep", "cache.md");
    const NEW = "fresh content\n";

    atomicWriteFile(dest, NEW);

    assert.equal(readFileSync(dest, "utf8"), NEW);
    assert.equal(existsSync(dest + ".tmp"), false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
