import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createSessionSetupCache,
  inspectHerdrConfig,
  isChildSession,
  isLocalSubagentDevelopmentSource,
  isRequiredSubagentPackageSource,
  parseSectionedToml,
  REQUIRED_SUBAGENT_FORK_COMMIT,
  REQUIRED_SUBAGENT_PACKAGE_SOURCE,
  runSetupChecks,
  type CommandRunner,
  type SetupCheckResult,
} from "../src/setup-checks.ts";

test("Herdr TOML parsing is section-sensitive", () => {
  const parsed = parseSectionedToml(`
[remote]
pane_history = true

[session]
resume_agents_on_restore = false

[experimental]
pane_history = true

[ui.toast]
delivery = "terminal"
`);

  assert.equal(parsed.values.get("remote.pane_history"), "true");
  assert.equal(parsed.values.get("experimental.pane_history"), "true");
  assert.equal(parsed.values.get("session.resume_agents_on_restore"), "false");
  assert.equal(parsed.values.get("ui.toast.delivery"), '"terminal"');
  assert.equal(parsed.values.has("pane_history"), false);

  const wrongSectionOnly = inspectHerdrConfig("[remote]\npane_history = true\nresume_agents_on_restore = false\n");
  assert.equal(wrongSectionOnly.paneHistoryEnabled, false);
  assert.equal(wrongSectionOnly.resumeExplicitlyFalse, false);

  const effective = inspectHerdrConfig("[session]\nresume_agents_on_restore = false\n[experimental]\npane_history = true\n");
  assert.equal(effective.resumeExplicitlyFalse, true);
  assert.equal(effective.paneHistoryEnabled, true);
});

test("session setup result is computed once and reused by every agent turn", () => {
  let calls = 0;
  const result: SetupCheckResult = {
    checkedAt: "2026-08-23T00:00:00.000Z",
    issues: [],
    working: ["ok"],
    notices: [],
    message: null,
  };
  const cache = createSessionSetupCache(() => { calls++; return result; });

  assert.equal(cache.current(), null);
  assert.equal(cache.run(), result); // session_start
  assert.equal(cache.current(), result); // before_agent_start #1
  assert.equal(cache.current(), result); // before_agent_start #2
  assert.equal(calls, 1);
});

function setupFixture() {
  const home = mkdtempSync(join(tmpdir(), "snorrio-setup-"));
  const snorrioHome = join(home, "snorrio");
  for (const dir of ["episodes", "cache/days", "cache/weeks", "cache/months", "cache/quarters", "cache/years", "logs", "config"]) mkdirSync(join(snorrioHome, dir), { recursive: true });
  writeFileSync(join(snorrioHome, "config/config.json"), "{}");
  mkdirSync(join(home, ".pi/agent/agents"), { recursive: true });
  writeFileSync(join(home, ".pi/agent/agents/recall-digger.md"), "---\nname: recall-digger\n---\n");
  writeFileSync(join(home, ".pi/agent/settings.json"), JSON.stringify({
    packages: ["https://github.com/lrhodin/snorrio", REQUIRED_SUBAGENT_PACKAGE_SOURCE],
  }));
  return { home, snorrioHome };
}

function healthyRunner(serviceOverride?: string): CommandRunner {
  return (command, args) => {
    const key = `${command} ${args.join(" ")}`;
    if (command === "which") return `/bin/${args[0]}`;
    if (key === "launchctl list io.snorrio.dmn") return '"PID" = 123;';
    if (key === "id -u") return "501";
    if (key === "id -un") return "tester";
    if (key === "launchctl print gui/501/io.snorrio.dmn") return "state = running";
    if (key === "herdr status server --json") return JSON.stringify({ running: true, compatible: true, restart_needed: false, version: "0.8.2" });
    if (key === "brew services info herdr --json") return serviceOverride ?? JSON.stringify([{ running: true, registered: true, user: "tester" }]);
    if (key === "herdr integration status") return "pi: current (v8)";
    if (key === "herdr config check") return "config: ok";
    return null;
  };
}

function runtimeEnv(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  return { HERDR_ENV: "1", HERDR_PANE_ID: "w1:p1", HERDR_TAB_ID: "w1:t1", HERDR_WORKSPACE_ID: "w1", HERDR_SOCKET_PATH: "/tmp/herdr.sock", ...extra };
}

test("injectable setup checks distinguish healthy, dead, and malformed Homebrew supervision", () => {
  const fixture = setupFixture();
  try {
    const common = { ...fixture, packageRoot: join(fixture.home, "pkg"), platform: "darwin" as const, env: runtimeEnv(), availableTools: ["subagent", "subagent_interrupt", "subagent_resume", "subagents_list"] };
    const healthy = runSetupChecks({ ...common, commandRunner: healthyRunner() });
    assert.equal(healthy.issues.length, 0, healthy.issues.join("\n"));
    assert.ok(healthy.working.includes("herdr Homebrew service running"));
    assert.ok(healthy.working.includes("daemon launchd supervisor registered"));

    const dead = runSetupChecks({ ...common, commandRunner: healthyRunner(JSON.stringify([{ running: false, registered: true, user: "tester" }])) });
    assert.ok(dead.issues.some(issue => /exists but is not running/.test(issue)));

    const malformed = runSetupChecks({ ...common, commandRunner: healthyRunner("not-json") });
    assert.ok(malformed.issues.some(issue => /cannot validate Herdr Homebrew supervision/.test(issue)));
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test("public setup surfaces pin and explain the required subagent fork", () => {
  const files = [
    new URL("../README.md", import.meta.url),
    new URL("../SETUP.md", import.meta.url),
    new URL("../skills/snorrio/SKILL.md", import.meta.url),
  ];
  for (const file of files) {
    const content = readFileSync(file, "utf8");
    assert.match(content, /lrhodin\/pi-herdr-subagents/);
    assert.ok(content.includes(REQUIRED_SUBAGENT_FORK_COMMIT));
    assert.match(content, /recursive|lineage/i);
  }
});

test("required subagent package source is exact while explicit local checkouts remain valid", () => {
  assert.equal(isRequiredSubagentPackageSource(REQUIRED_SUBAGENT_PACKAGE_SOURCE), true);
  assert.equal(
    isRequiredSubagentPackageSource(
      `https://github.com/lrhodin/pi-herdr-subagents@${REQUIRED_SUBAGENT_FORK_COMMIT}`,
    ),
    true,
  );
  assert.equal(isRequiredSubagentPackageSource("npm:pi-herdr-subagents"), false);
  assert.equal(isRequiredSubagentPackageSource("git:github.com/0xRichardH/pi-herdr-subagents"), false);
  assert.equal(isLocalSubagentDevelopmentSource("../../colter/projects/pi-herdr-subagents"), true);
  assert.equal(isLocalSubagentDevelopmentSource("/work/pi-herdr-subagents/"), true);
  assert.equal(isLocalSubagentDevelopmentSource("git:github.com/lrhodin/pi-herdr-subagents"), false);
});

test("setup rejects unpatched subagent packages and accepts an explicit local checkout", () => {
  const fixture = setupFixture();
  try {
    const settingsPath = join(fixture.home, ".pi/agent/settings.json");
    const common = {
      ...fixture,
      packageRoot: join(fixture.home, "pkg"),
      platform: "darwin" as const,
      env: runtimeEnv(),
      availableTools: ["subagent", "subagent_interrupt", "subagent_resume", "subagents_list"],
      commandRunner: healthyRunner(),
    };

    writeFileSync(settingsPath, JSON.stringify({
      packages: ["https://github.com/lrhodin/snorrio", "npm:pi-herdr-subagents"],
    }));
    const upstream = runSetupChecks(common);
    assert.ok(upstream.issues.some((issue) => /unsupported pi-herdr-subagents source/.test(issue)));
    assert.ok(upstream.issues.some((issue) => issue.includes(REQUIRED_SUBAGENT_PACKAGE_SOURCE)));

    writeFileSync(settingsPath, JSON.stringify({
      packages: ["https://github.com/lrhodin/snorrio", "../../projects/pi-herdr-subagents"],
    }));
    const local = runSetupChecks(common);
    assert.ok(local.working.includes("pi-herdr-subagents local development checkout installed"));
    assert.ok(!local.issues.some((issue) => /pi-herdr-subagents/.test(issue)));
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test("parent requires all defined lifecycle tools while PI_SUBAGENT_ID child may intentionally omit them", () => {
  const fixture = setupFixture();
  try {
    const common = { ...fixture, packageRoot: join(fixture.home, "pkg"), platform: "darwin" as const, commandRunner: healthyRunner(), availableTools: [] as string[] };
    const parent = runSetupChecks({ ...common, env: runtimeEnv({ PI_SUBAGENT_SHELL_READY_DELAY_MS: "500" }) });
    assert.ok(parent.issues.some(issue => /subagent lifecycle tools unavailable/.test(issue)));
    const child = runSetupChecks({ ...common, env: runtimeEnv({ PI_SUBAGENT_ID: "child-1" }) });
    assert.ok(!child.issues.some(issue => /subagent lifecycle tools unavailable/.test(issue)));
  } finally { rmSync(fixture.home, { recursive: true, force: true }); }
});

test("Pi subagent environment identifies children whose spawning tools may be intentionally denied", () => {
  assert.equal(isChildSession({}), false);
  assert.equal(isChildSession({ PI_SUBAGENT_ID: "abc" }), true);
  assert.equal(isChildSession({ PI_SUBAGENT_AGENT: "recall-digger" }), false);
  assert.equal(isChildSession({ PI_SUBAGENT_SHELL_READY_DELAY_MS: "500" }), false);
});
