// Data-repo versioning (interest-caches spec §3.3, Phase 0).
//
// ~/snorrio (the DATA dir, distinct from this source checkout) becomes a git
// repo so cache/episode history is preserved: live files keep being
// overwritten by atomicWrite exactly as before — git history is what
// preserves the contemporaneous view (the hindsight / Temporal-Council fix).
//
// Invariants:
//   - Self-initializing: ensureDataRepo() runs on daemon startup and before
//     every commit attempt. Idempotent.
//   - Repo-LOCAL identity only (user.name "snorrio", user.email
//     "dmn@snorr.io"). Global git config is never touched.
//   - git missing or any git failure → loud stderr warning, versioning
//     becomes a no-op. A failed git operation must NEVER block or crash
//     episode/cache writes — memory works without git.
//   - Commits are serialized: every git interaction in this module is fully
//     synchronous (execFileSync, no awaits between add and commit), so within
//     the single-threaded daemon process two commits can never interleave.
//     This is the in-process mutex, by construction.
//   - World-time authorship: commitDataRepo() sets GIT_AUTHOR_DATE to the
//     triggering session's episode timestamp; committer date stays "now"
//     (which is what `git rev-list --before` filters on — i.e. repo state
//     as of wall-clock T).

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";

const HOME = process.env.HOME!;

export interface DataRepoState {
  /** Resolved REAL path of the data dir (symlinks resolved). */
  root: string;
  /** false ⇒ git unavailable or init failed; all versioning is a no-op. */
  enabled: boolean;
}

// Ignore operational noise, not state: daemon logs, the flush trigger file,
// and atomicWrite's transient "<path>.tmp" staging files.
const DATA_GITIGNORE = `# snorrio data repo — operational noise, not state
logs/
flush
tmp/
*.tmp
.DS_Store
`;

/**
 * The data dir, with symlinks resolved. git must operate on the real path so
 * the repo lands where the data actually lives (~/snorrio may be reached
 * through a symlink chain).
 */
export function resolveDataRoot(): string {
  const raw = process.env.SNORRIO_HOME || join(HOME, "snorrio");
  try {
    return realpathSync(raw);
  } catch {
    return raw; // dir may not exist yet — ensureDataRepo creates it
  }
}

function warn(msg: string): void {
  process.stderr.write(`[snorrio:data-repo] WARNING: ${msg} — memory keeps working, versioning is skipped\n`);
}

function git(root: string, args: string[], env?: Record<string, string>): string {
  return execFileSync("git", ["-C", root, ...args], {
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
    env: env ? { ...process.env, ...env } : process.env,
  });
}

function gitAvailable(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return true;
  } catch {
    return false;
  }
}

// Per-root state cache. Enabled state is trusted while .git still exists;
// disabled state is always re-probed (so a transient failure — e.g. PATH
// fixed, git installed later — can recover without a daemon restart).
const states = new Map<string, DataRepoState>();
let warnedNoGit = false;

/**
 * Ensure the data dir is a git repo with repo-local identity. Idempotent;
 * called on daemon startup and internally before every commit. Never throws.
 */
export function ensureDataRepo(): DataRepoState {
  const root = resolveDataRoot();
  const cached = states.get(root);
  if (cached?.enabled && existsSync(join(root, ".git"))) return cached;

  const state: DataRepoState = { root, enabled: false };
  states.set(root, state);

  if (!gitAvailable()) {
    if (!warnedNoGit) {
      warnedNoGit = true;
      warn("git binary not found; data-dir versioning disabled");
    }
    return state;
  }

  try {
    mkdirSync(root, { recursive: true });
    const fresh = !existsSync(join(root, ".git"));
    if (fresh) git(root, ["init"]);

    // Repo-LOCAL identity (git config without --global writes .git/config).
    // Re-applied on every (re)initialization pass — idempotent.
    git(root, ["config", "user.name", "snorrio"]);
    git(root, ["config", "user.email", "dmn@snorr.io"]);
    // The daemon must never block on a signing setup the user has globally.
    git(root, ["config", "commit.gpgsign", "false"]);

    const giPath = join(root, ".gitignore");
    if (!existsSync(giPath)) writeFileSync(giPath, DATA_GITIGNORE);

    if (fresh) {
      git(root, ["add", "-A"]);
      git(root, ["commit", "--allow-empty", "-m", "snorrio data repo — initial snapshot"]);
    }

    state.enabled = true;
  } catch (err: any) {
    warn(`data repo init failed at ${root}: ${err?.message?.slice(0, 200)}`);
    state.enabled = false;
  }
  return state;
}

export interface DataRepoCommit {
  /** Short commit subject, e.g. "cascade 2026-06-09: episode 019e… → day/week/month/quarter/year". */
  message: string;
  /** World-time of the triggering session (ISO). Becomes GIT_AUTHOR_DATE; committer date stays now. */
  authorDate?: string;
}

/**
 * Stage everything (episodes + regenerated caches) and commit. No-op when
 * the tree is clean. Never throws; returns false (with a loud warning) on
 * any git failure so episode/cache writes are never blocked.
 *
 * Fully synchronous ⇒ serialized within the daemon process by construction
 * (the daemon is the only writer).
 */
export function commitDataRepo(commit: DataRepoCommit): boolean {
  const state = ensureDataRepo();
  if (!state.enabled) return false;

  try {
    git(state.root, ["add", "-A"]);

    // `diff --cached --quiet` exits 0 when nothing is staged → skip commit.
    try {
      git(state.root, ["diff", "--cached", "--quiet", "HEAD"]);
      return true; // clean tree — nothing to version
    } catch {
      /* staged changes exist — fall through to commit */
    }

    const env: Record<string, string> = {};
    if (commit.authorDate) env.GIT_AUTHOR_DATE = commit.authorDate;
    git(state.root, ["commit", "-m", commit.message], env);
    return true;
  } catch (err: any) {
    warn(`commit failed in ${state.root}: ${err?.message?.slice(0, 200)}`);
    return false;
  }
}
