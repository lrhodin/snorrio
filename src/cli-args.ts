// Subcommand flag validation.
//
// Why this exists: `snorrio migrate-provenance --help` used to RUN the real
// migration. The daemon dispatched on `process.argv.includes("--migrate-provenance")`
// and read the dry-run switch with a second `includes("--dry-run")`, so an
// unrecognized flag was not rejected — it was ignored, and the mutating branch
// ran with `dryRun: false`. An operator reaching for documentation got a live
// 26-day cascade instead (2026-08-24). The lesson is narrow and worth keeping in
// code: for a command that writes, an argument we do not understand is a reason
// to stop, never a reason to proceed with defaults.
//
// Kept as its own module rather than inline in `bin/snorrio` so the rules are
// unit-testable without spawning a process that might mutate memory.

export const HELP_FLAGS = ["--help", "-h", "help"] as const;

export interface FlagSpec {
  /** Flags the subcommand accepts, e.g. ["--dry-run"]. */
  allowed: string[];
  /** Count of accepted bare positional arguments (e.g. reprocess <range> [depth]). */
  positionals?: number;
}

export interface FlagCheck {
  /** True when the caller asked for usage and nothing should execute. */
  help: boolean;
  /** Present only when the arguments are invalid; a ready-to-print message. */
  error?: string;
  /** Accepted flags, in the order given. */
  flags: string[];
  /** Accepted positionals, in the order given. */
  positionals: string[];
}

/**
 * Validate the arguments of a single subcommand.
 *
 * Returns `help: true` if any help flag appears anywhere — help must win over
 * execution, because that is exactly the case that misfired. Otherwise returns
 * an `error` for the first unrecognized flag or surplus positional, and never
 * silently drops an argument.
 */
export function checkSubcommandArgs(cmd: string, args: string[], spec: FlagSpec): FlagCheck {
  const allowed = new Set(spec.allowed);
  const maxPositionals = spec.positionals ?? 0;
  const flags: string[] = [];
  const positionals: string[] = [];

  if (args.some((arg) => (HELP_FLAGS as readonly string[]).includes(arg))) {
    return { help: true, flags, positionals };
  }

  for (const arg of args) {
    if (arg.startsWith("-")) {
      if (!allowed.has(arg)) {
        const hint = spec.allowed.length
          ? `Accepted flags: ${spec.allowed.join(", ")}`
          : "This command accepts no flags.";
        return {
          help: false,
          error: `Unknown flag for '${cmd}': ${arg}\n${hint}\nRun 'snorrio ${cmd} --help' for usage.`,
          flags,
          positionals,
        };
      }
      flags.push(arg);
      continue;
    }
    if (positionals.length >= maxPositionals) {
      return {
        help: false,
        error: `Unexpected argument for '${cmd}': ${arg}\nRun 'snorrio ${cmd} --help' for usage.`,
        flags,
        positionals,
      };
    }
    positionals.push(arg);
  }

  return { help: false, flags, positionals };
}
