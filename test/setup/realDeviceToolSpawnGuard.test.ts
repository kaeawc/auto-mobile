import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { exec, execFile, execFileSync, execSync, fork, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  BUN_SHELL_COMMAND,
  blockedToolForArgv,
  drainViolations,
  hostCommandName,
  installRealDeviceToolSpawnGuard,
  isUnitTestPath,
  neverAllowListable,
  parseHostSpawnAllowList,
  spawnArgv,
  testFileFromStack,
  type HostSpawnAllowList,
  type SpawnGuardDependencies,
  type SpawnTarget,
  type Violation,
} from "./realDeviceToolSpawnGuard";

const EXAMPLE_FILE = "test/setup/example.test.ts";
const allowing = (testFile: string, ...commands: string[]): HostSpawnAllowList =>
  new Map([[testFile, new Set(commands)]]);

function fakeGuard(overrides: Partial<SpawnGuardDependencies> = {}) {
  const calls: { receiver: unknown; args: unknown[] }[] = [];
  const result = { fake: true };
  function original(this: unknown, first: unknown, ...rest: unknown[]) {
    calls.push({ receiver: this, args: [first, ...rest] });
    return result;
  }
  const target: SpawnTarget = { spawn: original, spawnSync: original };
  const report: Violation[] = [];
  const deps: SpawnGuardDependencies = {
    target,
    report,
    testFile: EXAMPLE_FILE,
    loadAllowList: () => new Map(),
    mode: "enforce",
    ...overrides,
  };
  const restore = installRealDeviceToolSpawnGuard(deps);
  return { target, report, result, calls, original, deps, restore };
}

test("stack attribution recognizes caller files, Windows paths and retained async frames", () => {
  expect(testFileFromStack(undefined)).toBeUndefined();
  expect(testFileFromStack("Error\n    at work (/repo/src/worker.ts:1:2)")).toBeUndefined();
  expect(
    testFileFromStack(
      "Error\n    at spawn (/repo/src/worker.ts:1:2)\n    at async run (/repo/test/actual.test.ts:3:4)",
    ),
  ).toBe("/repo/test/actual.test.ts");
  expect(testFileFromStack("Error\n    at run (C:\\my repo\\test\\actual.test.ts:3:4)")).toBe(
    "C:/my repo/test/actual.test.ts",
  );
  expect(testFileFromStack("Error\n    at run (/repo/test/host.integration.test.ts:3:4)")).toBe(
    "/repo/test/host.integration.test.ts",
  );
});

test("runtime attribution changes allow-list and unit policy per launch, even after an exempt first file", () => {
  let file = "test/host.integration.test.ts";
  let loads = 0;
  const guard = fakeGuard({
    testFile: file,
    getTestFile: () => file,
    loadAllowList: () => {
      loads++;
      return allowing("test/allowed.test.ts", "git");
    },
  });
  expect(guard.target.spawn(["ffmpeg", "-version"])).toBe(guard.result);
  expect(guard.target.spawn(["adb"])).toBe(guard.result);
  expect(loads).toBe(0);
  file = "test/allowed.test.ts";
  expect(guard.target.spawn(["git", "status"])).toBe(guard.result);
  file = "test/offender.test.ts";
  expect(() => guard.target.spawn(["git", "status"])).toThrow("test/offender.test.ts");
  expect(guard.report[0].testFile).toBe(file);
  file = "test/stress/host.test.ts";
  expect(guard.target.spawn(["adb"])).toBe(guard.result);
  expect(loads).toBe(1);
  expect(guard.calls).toHaveLength(4);
});

test("a test drains only its own scope, leaving outside-test violations for one file failure", () => {
  const first = {};
  const second = {};
  const outside = { testFile: "test/late.test.ts", tool: "adb", argv: ["adb"] };
  const report: Violation[] = [
    { ...outside, testFile: "test/first.test.ts", testScope: first },
    outside,
  ];
  expect(() => drainViolations(report, (v) => v.testScope === first)).toThrow("test/first.test.ts");
  expect(() => drainViolations(report, (v) => v.testScope === second)).not.toThrow();
  expect(report).toEqual([outside]);
  expect(() => drainViolations(report, (v) => v.testFile === outside.testFile)).toThrow(
    "test/late.test.ts",
  );
  expect(() => drainViolations(report)).not.toThrow();
});

test("runtime census records the actual file independently of the allow-list", () => {
  const records: string[] = [];
  const guard = fakeGuard({
    mode: "census",
    getTestFile: () => "test/actual.test.ts",
    record: (_tool, _argv, file) => records.push(file),
  });
  expect(() => guard.target.spawn(["adb"])).toThrow("ENOENT");
  expect(records).toEqual(["test/actual.test.ts"]);
  expect(guard.report).toHaveLength(0);
});

test("blocked executable names, absolute paths and Windows extensions are case-sensitive", () => {
  for (const tool of [
    "adb",
    "xcrun",
    "xcodebuild",
    "simctl",
    "devicectl",
    "emulator",
    "avdmanager",
    "sdkmanager",
    "ffmpeg",
    "curl",
  ]) {
    for (const command of [tool, `/usr/bin/${tool}`, `${tool}.exe`, `${tool}.cmd`, `${tool}.bat`]) {
      expect(blockedToolForArgv([command])).toBe(tool);
    }
  }
  expect(blockedToolForArgv(["/Users/x/Library/Android/sdk/platform-tools/adb"])).toBe("adb");
  expect(blockedToolForArgv(["C:\\t\\adb.EXE"])).toBe("adb");
  expect(blockedToolForArgv(["ADB"])).toBeUndefined();
});

test("lookups and shell command segments detect blocked tools", () => {
  const cases: [string[], string][] = [
    [["which", "adb"], "adb"],
    [["which", "-a", "xcrun"], "xcrun"],
    [["where", "adb"], "adb"],
    [["command", "-v", "curl"], "curl"],
    [["sh", "-c", "adb devices"], "adb"],
    [["bash", "-c", "FOO=1 curl x"], "curl"],
    [["zsh", "-c", "exec command env BAR=2 xcrun --version"], "xcrun"],
    [["cmd", "/d", "/s", "/C", "adb", "devices"], "adb"],
  ];
  for (const operator of [";", "&&", "||", "|", "&", "\n", "\r\n"]) {
    cases.push([["sh", "-c", `echo hi ${operator} adb devices`], "adb"]);
  }
  for (const [argv, tool] of cases) {
    expect(blockedToolForArgv(argv)).toBe(tool);
  }
  expect(blockedToolForArgv(["which", "git"])).toBeUndefined();
  expect(blockedToolForArgv(["sh", "-c", "git status"])).toBeUndefined();
});

test("cmd command strings unwrap one outer quote pair across platforms", () => {
  for (const shell of ["cmd", "cmd.exe", "C:\\Windows\\system32\\cmd.exe"]) {
    for (const flag of ["/c", "/C", "/k", "/K"]) {
      for (const command of ["adb devices", '"adb devices"', '"adb devices && echo ok"']) {
        const argv = [shell, "/d", "/s", flag, command];
        expect(blockedToolForArgv(argv), JSON.stringify(argv)).toBe("adb");
      }
      expect(blockedToolForArgv([shell, "/d", "/s", flag, '"echo hello"'])).toBeUndefined();
    }
  }
  expect(blockedToolForArgv(["cmd.exe", "/d", "/s", '"adb devices"'])).toBeUndefined();
});

test("env long options and short clusters preserve command and operand boundaries", () => {
  const options = [
    ["--block-signal"],
    ["--block-signal=INT"],
    ["--default-signal"],
    ["--default-signal=TERM"],
    ["--ignore-signal"],
    ["--ignore-signal=PIPE"],
    ["--list-signal-handling"],
    ["--argv0", "label"],
    ["--argv0=label"],
    ["-a", "label"],
    ["-alabel"],
    ["-iv"],
    ["-0i"],
    ["-iu", "FOO"],
    ["-iuFOO"],
    ["-iC", "/tmp"],
    ["-iC/tmp"],
    ["-ia", "label"],
    ["-ialabel"],
  ];
  for (const flags of options) {
    expect(blockedToolForArgv(["env", ...flags, "adb", "devices"]), JSON.stringify(flags)).toBe(
      "adb",
    );
    expect(
      blockedToolForArgv(["env", ...flags, "echo", "hello"]),
      JSON.stringify(flags),
    ).toBeUndefined();
  }
  for (const flags of [
    ["--argv0", "adb"],
    ["--argv0=adb"],
    ["-ia", "adb"],
    ["-iu", "adb"],
    ["-iuadb"],
    ["-iC", "adb"],
  ]) {
    expect(
      blockedToolForArgv(["env", ...flags, "echo", "hello"]),
      JSON.stringify(flags),
    ).toBeUndefined();
  }
});

test.each([
  [["env", "-iS", "adb devices"], "adb"],
  [["env", "-S", "adb devices"], "adb"],
  [["env", "-iSadb", "devices"], "adb"],
  [["env", "-iSadb devices"], "adb"],
  [["env", "-Sadb devices"], "adb"],
  [["env", "--split-string=adb devices"], "adb"],
  [["env", "-u", "FOO", "adb"], "adb"],
  [["env", "-iu", "FOO", "-iS", "adb devices"], "adb"],
  [["env", "-uS", "echo", "hi"], undefined],
  [["env", "-i", "true"], undefined],
] satisfies [string[], string | undefined][])("env split/operand boundary %j", (argv, tool) => {
  expect(blockedToolForArgv(argv)).toBe(tool);
});

test.each([
  ['FOO="hello world" adb devices', "adb"],
  ["FOO='a b' xcrun simctl list", "xcrun"],
  ['FOO="a b" echo hi', undefined],
  ['FOO="a adb', "adb"],
  ["$(adb devices)", "adb"],
  ['echo "$(adb devices)"', "adb"],
  ["echo `adb devices`", "adb"],
  ["FOO=hello\\ world adb devices", "adb"],
  ['FOO="escaped\\\" value" adb devices', "adb"],
  ["a\\db devices", "adb"],
  ['echo "adb"', undefined],
  ["echo 'adb devices'", undefined],
  ['echo "hello; adb devices"', undefined],
  ["echo '$(adb devices)'", undefined],
  ['echo "unbalanced adb', "adb"],
  ['echo "unbalanced myadb', undefined],
] satisfies [string, string | undefined][])("shell token boundary %j", (command, tool) => {
  expect(blockedToolForArgv(["sh", "-c", command])).toBe(tool);
});

test("wrapper option operands are skipped before recursively checking commands", () => {
  const blocked = [
    ["env", "-u", "ANDROID_SERIAL", "adb", "devices"],
    ["env", "-uANDROID_SERIAL", "adb"],
    ["env", "--unset=ANDROID_SERIAL", "adb"],
    ["env", "--unset", "ANDROID_SERIAL", "adb"],
    ["env", "-C", "/tmp", "adb"],
    ["env", "-C/tmp", "adb"],
    ["env", "--chdir=/tmp", "adb"],
    ["env", "--chdir", "/tmp", "adb"],
    ["env", "-S", "adb devices"],
    ["env", "-S", "-u ANDROID_SERIAL adb devices"],
    ["env", "-S", "echo ready && adb devices"],
    ["env", "-Sadb devices"],
    ["env", "--split-string=adb devices"],
    ["env", "--split-string", "adb devices"],
    ["env", "-i", "--ignore-environment", "-", "-0", "-v", "--", "FOO=1", "adb"],
    ["timeout", "-s", "TERM", "-k", "2s", "--foreground", "3s", "adb"],
    [
      "timeout",
      "--signal=TERM",
      "--kill-after=2s",
      "--preserve-status",
      "--verbose",
      "--",
      "3",
      "adb",
    ],
    ["timeout", "-sTERM", "-k2", "3", "adb"],
    ["nice", "-n", "10", "adb"],
    ["nice", "-n10", "adb"],
    ["nice", "-10", "adb"],
    ["nice", "--adjustment=10", "adb"],
    ["nice", "--adjustment", "10", "adb"],
    ["nohup", "--", "adb"],
    ["exec", "-a", "label", "-c", "-l", "adb"],
    ["exec", "-alabel", "adb"],
    ["exec", "-cla", "label", "adb"],
    ["command", "-p", "adb"],
    ["command", "-v", "git", "adb"],
    ["command", "-V", "git", "adb"],
    ["command", "-pv", "git", "adb"],
    ["bash", "-lc", "adb devices"],
    ["sh", "-e", "-c", "adb devices"],
    ["bash", "-o", "errexit", "-c", "adb devices"],
    ["where", "/r", "/tmp", "adb"],
    ["FOO=1", "BAR=2", "env", "-u", "NAME", "nice", "-n", "3", "nohup", "adb"],
  ];
  for (const argv of blocked) {
    expect(blockedToolForArgv(argv), JSON.stringify(argv)).toBe("adb");
  }
  const benign = [
    ["env", "-u", "ANDROID_SERIAL", "git", "status"],
    ["env", "-u", "adb", "git", "status"],
    ["env", "-uadb", "git"],
    ["env", "--unset", "adb", "git"],
    ["env", "--unset=adb", "git"],
    ["env", "-C", "adb", "git"],
    ["env", "--chdir", "adb", "git"],
    ["env", "-S", "git status"],
    ["timeout", "-s", "adb", "3", "git"],
    ["timeout", "-k", "adb", "3", "git"],
    ["nice", "-n", "10", "git"],
    ["nohup", "git"],
    ["exec", "-a", "adb", "git"],
    ["exec", "-aadb", "git"],
    ["command", "-p", "git"],
    ["command", "-v", "git"],
    ["where", "/r", "adb", "git"],
    ["sh", "script.sh", "-c", "adb"],
    ["bash", "-o", "adb", "script.sh"],
  ];
  for (const argv of benign) {
    expect(blockedToolForArgv(argv), JSON.stringify(argv)).toBeUndefined();
  }
});

test("spawn argument extraction rejects malformed inputs", () => {
  expect(spawnArgv([["git", "status"]])).toEqual(["git", "status"]);
  expect(spawnArgv([{ cmd: ["git"] }])).toEqual(["git"]);
  for (const args of [[], [null], [{ cmd: "adb" }], [["adb", 1]]]) {
    expect(spawnArgv(args)).toEqual([]);
  }
});

test("array and options forms block both APIs without calling originals", () => {
  const guard = fakeGuard();
  for (const method of [guard.target.spawn, guard.target.spawnSync]) {
    for (const arg of [["adb", "devices"], { cmd: ["adb", "devices"] }]) {
      expect(() => method(arg)).toThrow(
        /test\/setup\/example\.test\.ts.*adb devices.*FakeProcessExecutor.*can never be allow-listed/s,
      );
    }
  }
  expect(guard.calls).toHaveLength(0);
  expect(guard.report).toHaveLength(4);
  guard.restore();
});

test("an allow-listed command preserves receiver, arguments, exact result and function length", () => {
  const commands = ["git", "ps", "bash", "node", "bun", "plutil"];
  let loads = 0;
  const guard = fakeGuard({
    loadAllowList: () => {
      loads++;
      return allowing(EXAMPLE_FILE, ...commands);
    },
  });
  const receiver = { example: true };
  const options = { stdout: "pipe" };
  for (const command of commands) {
    const argv = [command];
    expect(guard.target.spawn.call(receiver, argv, options)).toBe(guard.result);
    expect(guard.calls.at(-1)).toEqual({ receiver, args: [argv, options] });
  }
  expect(guard.target.spawnSync({ cmd: ["/usr/bin/git", "status"] })).toBe(guard.result);
  expect(guard.calls).toHaveLength(7);
  expect(guard.target.spawn.length).toBe(guard.original.length);
  expect(loads).toBe(1);
  expect(guard.report).toHaveLength(0);
});

test("every launch from a unit test is refused unless its file lists that command", () => {
  const guard = fakeGuard({ loadAllowList: () => allowing("test/other.test.ts", "git") });
  for (const method of [guard.target.spawn, guard.target.spawnSync]) {
    expect(() => method(["/usr/bin/git", "status"])).toThrow(
      /host command spawned by a unit test: test\/setup\/example\.test\.ts: \/usr\/bin\/git status \(git\).*add "test\/setup\/example\.test\.ts git".*scripts\/unit-test-host-spawn-allowlist\.txt/s,
    );
  }
  // A launch the guard cannot read has no command an entry could name.
  for (const args of [[], [null], [{ cmd: "git" }], [["git", 1]]]) {
    expect(() => guard.target.spawn(...(args as never[]))).toThrow("(unparsed)");
  }
  expect(guard.calls).toHaveLength(0);
  expect(guard.report.map((violation) => violation.forbidden)).toEqual(Array(6).fill(false));
  expect(guard.report[0].origin).toContain("realDeviceToolSpawnGuard.test.ts");
  expect(hostCommandName(["C:\\tools\\git.exe"])).toBe("git");
});

// The names the owner ruled out after the unit suite drove a developer's emulator (2026-10-11).
const NEVER_ALLOW_LISTABLE = [
  "adb",
  "xcrun",
  "simctl",
  "emulator",
  "avdmanager",
  "defaults",
  "gsettings",
  "auto-mobile",
  "sdkmanager",
  "xcodebuild",
  "devicectl",
];

test("a device, simulator, host-settings or daemon command is refused even when it is listed", () => {
  const listed = NEVER_ALLOW_LISTABLE.map((tool) => `${EXAMPLE_FILE} ${tool}`).join("\n");
  const parsed = parseHostSpawnAllowList(`${listed}\n${EXAMPLE_FILE} git\n`);
  expect([...parsed.allowList]).toEqual([[EXAMPLE_FILE, new Set(["git"])]]);
  expect(parsed.errors).toEqual(
    NEVER_ALLOW_LISTABLE.map(
      (tool, index) => `line ${index + 1}: ${tool} can never be allow-listed`,
    ),
  );
  // Even an allow-list built without the parser cannot let one through.
  const guard = fakeGuard({
    loadAllowList: () => allowing(EXAMPLE_FILE, "sh", "env", "which", ...NEVER_ALLOW_LISTABLE),
  });
  for (const tool of NEVER_ALLOW_LISTABLE) {
    for (const argv of [
      [tool],
      [`/opt/sdk/${tool}`, "devices"],
      ["sh", "-c", `${tool} --version`],
      ["env", "A=1", tool],
      ["which", tool],
    ]) {
      expect(() => guard.target.spawn(argv), argv.join(" ")).toThrow("can never be allow-listed");
    }
  }
  expect(guard.target.spawn(["sh", "-c", "echo ok"])).toBe(guard.result);
  expect(guard.calls).toHaveLength(1);
  expect(guard.report.every((violation) => violation.forbidden)).toBe(true);
});

test("the device rule ignores case, and a wrapper the guard cannot see through is never listable", () => {
  // A case-insensitive file system runs adb for ADB.
  expect(neverAllowListable(["ADB", "devices"])).toBe("adb");
  expect(neverAllowListable(["/opt/sdk/Adb.EXE"])).toBe("adb");
  expect(neverAllowListable(["sh", "-c", "XCRUN simctl list"])).toBe("xcrun");
  const wrappers = ["sudo", "doas", "xargs", "script", "osascript", "stdbuf", "setsid", "open"];
  const parsed = parseHostSpawnAllowList(
    ["ADB", ...wrappers].map((command) => `${EXAMPLE_FILE} ${command}`).join("\n"),
  );
  expect(parsed.allowList.size).toBe(0);
  expect(parsed.errors).toHaveLength(wrappers.length + 1);
  const guard = fakeGuard({ loadAllowList: () => allowing(EXAMPLE_FILE, "ADB", ...wrappers) });
  for (const argv of [["ADB"], ...wrappers.map((wrapper) => [wrapper, "adb", "devices"])]) {
    expect(() => guard.target.spawn(argv), argv.join(" ")).toThrow("can never be allow-listed");
  }
  expect(guard.calls).toHaveLength(0);
});

test("a launch that names the resident daemon's socket, pid or lock file is refused", () => {
  const guard = fakeGuard({ loadAllowList: () => allowing(EXAMPLE_FILE, "bun", "nc", "sh") });
  for (const argv of [
    ["nc", "-U", "/tmp/auto-mobile-daemon-501.sock"],
    ["bun", "cli.js", "--socket=/tmp/auto-mobile-daemon-501.sock"],
    ["sh", "-c", "cat /tmp/auto-mobile-daemon-501.pid"],
    ["sh", "-c", "rm /tmp/auto-mobile-daemon-default.lock"],
  ]) {
    expect(neverAllowListable(argv)).toBe("resident daemon socket");
    expect(() => guard.target.spawn(argv)).toThrow("can never be allow-listed");
  }
  // An isolated daemon's files carry a hash suffix and stay a matter for the allow-list.
  const isolated = ["nc", "-U", "/tmp/auto-mobile-daemon-501-0123456789.sock"];
  expect(neverAllowListable(isolated)).toBeUndefined();
  expect(guard.target.spawn(isolated)).toBe(guard.result);
});

test("the allow-list parser reports every line that is not a unit test file and a bare command", () => {
  const parsed = parseHostSpawnAllowList(
    [
      "# comment",
      "",
      "test/a.test.ts git",
      "test/a.test.ts\tbun",
      `test/a.test.ts ${BUN_SHELL_COMMAND}`,
      "test/a.test.ts",
      "test/a.test.ts git status",
      "test/a.integration.test.ts git",
      "src/a.test.ts git",
      "test/stress/a.test.ts git",
      "test/a.test.ts /usr/bin/git",
      "test/a.test.ts (unparsed)",
    ].join("\r\n"),
  );
  expect([...parsed.allowList]).toEqual([
    ["test/a.test.ts", new Set(["git", "bun", BUN_SHELL_COMMAND])],
  ]);
  expect(parsed.errors).toEqual([
    'line 6: expected "<unit test file> <command>", got "test/a.test.ts"',
    'line 7: expected "<unit test file> <command>", got "test/a.test.ts git status"',
    "line 8: test/a.integration.test.ts is not a repo-relative unit test file",
    "line 9: src/a.test.ts is not a repo-relative unit test file",
    "line 10: test/stress/a.test.ts is not a repo-relative unit test file",
    "line 11: /usr/bin/git must be a bare command name, not a path",
    "line 12: (unparsed) can never be allow-listed",
  ]);
});

function fakeShellGuard(allowList: HostSpawnAllowList = new Map()) {
  const scripts: string[] = [];
  const shell = Object.assign(
    (strings: TemplateStringsArray, ...values: unknown[]) => {
      scripts.push(String.raw({ raw: strings }, ...values));
      return "ran";
    },
    { escape: (value: string) => `escaped ${value}` },
  );
  const target: SpawnTarget = { spawn: () => 0, spawnSync: () => 0, $: shell };
  const guard = fakeGuard({ target, loadAllowList: () => allowList });
  return { ...guard, target, shell, scripts, $: target.$ as unknown as typeof shell };
}

test("Bun's shell template is refused unless the file lists Bun.$", () => {
  const refused = fakeShellGuard();
  expect(() => refused.$`git status ${"--short"}`).toThrow(
    /host command spawned by a unit test: .*Bun\.\$ git status --short \(Bun\.\$\)/,
  );
  expect(refused.$.escape("x")).toBe("escaped x");
  expect(refused.scripts).toEqual([]);

  const listed = fakeShellGuard(allowing(EXAMPLE_FILE, BUN_SHELL_COMMAND));
  expect(listed.$`git status ${"--short"}`).toBe("ran");
  expect(() => listed.$`ls && adb ${"devices"}`).toThrow("can never be allow-listed");
  expect(() => listed.$`cat /tmp/auto-mobile-daemon-501.pid`).toThrow("resident daemon socket");
  // Bun's shell spreads an array into words and takes `{ raw }` as shell text.
  expect(() => listed.$`${["adb", "devices"]}`).toThrow("can never be allow-listed");
  expect(() => listed.$`${{ raw: "ls; adb devices" }}`).toThrow("can never be allow-listed");
  expect(listed.scripts).toEqual(["git status --short"]);
  listed.restore();
  expect(listed.target.$).toBe(listed.shell);
});

test("integration and stress files remain untouched; unit paths normalize Windows separators", () => {
  for (const testFile of [
    "test/stress/x.test.ts",
    "test/x.integration.test.ts",
    "test/example.ts",
  ]) {
    const guard = fakeGuard({ testFile });
    expect(guard.target.spawn).toBe(guard.original);
    expect(guard.target.spawnSync).toBe(guard.original);
  }
  expect(isUnitTestPath("test\\unit\\x.test.ts")).toBe(true);
  expect(isUnitTestPath("C:\\repo\\test\\stress\\x.test.ts")).toBe(false);
});

test("installation is idempotent and restore returns originals without removing another owner's replacement", () => {
  const guard = fakeGuard();
  const first = guard.target.spawn;
  const secondRestore = installRealDeviceToolSpawnGuard(guard.deps);
  expect(guard.target.spawn).toBe(first);
  secondRestore();
  expect(guard.target.spawn).toBe(first);
  guard.restore();
  expect(guard.target.spawn).toBe(guard.original);
  expect(guard.target.spawnSync).toBe(guard.original);
  const another = fakeGuard();
  another.target.spawn = guard.original;
  another.restore();
  expect(another.target.spawn).toBe(guard.original);
});

test("swallowed violations drain once and clear before throwing", () => {
  const guard = fakeGuard();
  try {
    guard.target.spawn(["adb"]);
  } catch (error) {
    // Deliberately swallow the synchronous failure to exercise the hook backstop.
    expect(error).toBeInstanceOf(Error);
  }
  expect(guard.report).toHaveLength(1);
  expect(() => drainViolations(guard.report)).toThrow(
    /real device tool spawned.*\nLaunched from:\n.*realDeviceToolSpawnGuard\.test\.ts/s,
  );
  expect(guard.report).toHaveLength(0);
  expect(() => drainViolations(guard.report)).not.toThrow();
});

test("census records and blocks with ENOENT regardless of allow-list, without enforcement violations", () => {
  const records: { tool: string; argv: readonly string[] }[] = [];
  const guard = fakeGuard({
    mode: "census",
    loadAllowList: () => {
      throw new Error("must not load");
    },
    record: (tool, argv) => records.push({ tool, argv }),
  });
  let caught: unknown;
  try {
    guard.target.spawn(["adb", "devices"]);
  } catch (error) {
    // Capture the expected census failure so a missing throw also fails below.
    caught = error;
  }
  expect(caught).toHaveProperty("code", "ENOENT");
  expect(records).toEqual([{ tool: "adb", argv: ["adb", "devices"] }]);
  expect(guard.calls).toHaveLength(0);
  expect(guard.report).toHaveLength(0);
});

test("census records every launch, runs the listable ones and still refuses the rest", () => {
  const records: unknown[][] = [];
  const guard = fakeGuard({
    mode: "census",
    loadAllowList: () => {
      throw new Error("must not load");
    },
    record: (...row) => records.push(row),
  });
  expect(guard.target.spawn(["/usr/bin/git", "status"])).toBe(guard.result);
  expect(() => guard.target.spawnSync(["defaults", "read", "-g"])).toThrow("ENOENT");
  expect(records).toEqual([
    ["git", ["/usr/bin/git", "status"], EXAMPLE_FILE, false],
    ["defaults", ["defaults", "read", "-g"], EXAMPLE_FILE, true],
  ]);
  expect(guard.calls).toHaveLength(1);
  expect(guard.report).toHaveLength(0);
});

describe("Bun child_process interception (imports captured before installation)", () => {
  let dir: string;
  let marker: string;
  let previousPath: string | undefined;
  let restore: () => void;
  const report: Violation[] = [];
  const originals = { spawn: Bun.spawn, spawnSync: Bun.spawnSync, $: Bun.$ };
  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "spawn-guard-"));
    marker = join(dir, "launched");
    const stub = join(dir, "adb");
    writeFileSync(stub, `#!/bin/sh\n: > '${marker}'\nexit 0\n`);
    chmodSync(stub, 0o755);
    previousPath = process.env.PATH;
    process.env.PATH = `${dir}:${previousPath ?? ""}`;
  });
  beforeEach(() => {
    // Fresh forwarding functions let this test own its report independently of
    // the global preload's idempotence marker. Blocked calls never reach them.
    Bun.spawn = function (...args: unknown[]) {
      return Reflect.apply(originals.spawn, Bun, args);
    } as typeof Bun.spawn;
    Bun.spawnSync = function (...args: unknown[]) {
      return Reflect.apply(originals.spawnSync, Bun, args);
    } as typeof Bun.spawnSync;
    Bun.$ = function (...args: unknown[]) {
      return Reflect.apply(originals.$, Bun, args);
    } as typeof Bun.$;
    restore = installRealDeviceToolSpawnGuard({
      target: Bun,
      testFile: "test/setup/example.test.ts",
      loadAllowList: () => new Map(),
      mode: "enforce",
      report,
    });
  });
  afterEach(() => {
    restore();
    Bun.spawn = originals.spawn;
    Bun.spawnSync = originals.spawnSync;
    Bun.$ = originals.$;
    report.splice(0);
    expect(existsSync(marker)).toBe(false);
  });
  afterAll(() => {
    if (previousPath === undefined) {
      delete process.env.PATH;
    } else {
      process.env.PATH = previousPath;
    }
    rmSync(dir, { recursive: true, force: true });
  });
  for (const [name, invoke] of [
    ["spawn", () => spawn("adb", ["devices"])],
    ["execFile", () => execFile("adb", ["devices"])],
    ["exec", () => exec("adb devices")],
    ["execSync", () => execSync("adb devices")],
    ["execFileSync", () => execFileSync("adb", ["devices"])],
    ["spawn shell:true", () => spawn("adb", ["devices"], { shell: true })],
  ] as const) {
    test(`${name} throws synchronously and records a violation`, () => {
      expect(invoke).toThrow("real device tool spawned");
      expect(report).toHaveLength(1);
    });
  }
  // Every node:child_process launcher reads Bun.spawn/Bun.spawnSync at the call, so an unlisted
  // harmless command is refused through each of them too. Nothing here reaches a process.
  for (const [name, invoke] of [
    ["spawn", () => spawn("true")],
    ["execFile", () => execFile("true")],
    ["exec", () => exec("true")],
    ["execSync", () => execSync("true")],
    ["execFileSync", () => execFileSync("true")],
    ["fork", () => fork(join(dir, "missing-module.js"))],
    ["Bun.spawn", () => Bun.spawn(["true"])],
    ["Bun.spawnSync", () => Bun.spawnSync({ cmd: ["true"] })],
    ["Bun.$", () => Bun.$`true`],
  ] as const) {
    test(`${name} of an unlisted command throws synchronously and records a violation`, () => {
      expect(invoke).toThrow("host command spawned by a unit test");
      expect(report).toHaveLength(1);
      expect(report[0].forbidden).toBe(false);
    });
  }
  test("spawnSync of an unlisted command returns the refusal as its error", () => {
    expect(spawnSync("true").error?.message).toContain("host command spawned by a unit test");
    expect(report).toHaveLength(1);
  });
  test("Bun's shell refuses a device tool whatever the allow-list says", () => {
    expect(() => Bun.$`adb ${"devices"}`).toThrow("real device tool spawned");
    expect(report[0]).toMatchObject({ tool: "adb", forbidden: true });
  });
  test("spawnSync returns an error and still records the violation", () => {
    expect(spawnSync("adb").error?.message).toContain("real device tool spawned");
    expect(report).toHaveLength(1);
  });
  test("awaiting promisified execFile and exec fails and records violations", async () => {
    // Bun's custom promisifiers can throw before returning a promise. An async
    // consumer handles either that synchronous throw or a rejected promise.
    await expect((async () => await promisify(execFile)("adb"))()).rejects.toThrow(
      "real device tool spawned",
    );
    await expect((async () => await promisify(exec)("adb devices"))()).rejects.toThrow(
      "real device tool spawned",
    );
    expect(report).toHaveLength(2);
  });
});
