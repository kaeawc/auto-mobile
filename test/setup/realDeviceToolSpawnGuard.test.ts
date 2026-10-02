import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { exec, execFile, execFileSync, execSync, spawn, spawnSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import {
  blockedToolForArgv,
  drainViolations,
  installRealDeviceToolSpawnGuard,
  isUnitTestPath,
  spawnArgv,
  testFileFromStack,
  type SpawnGuardDependencies,
  type Violation,
} from "./realDeviceToolSpawnGuard";

function fakeGuard(overrides: Partial<SpawnGuardDependencies> = {}) {
  const calls: { receiver: unknown; args: unknown[] }[] = [];
  const result = { fake: true };
  function original(this: unknown, first: unknown, ...rest: unknown[]) {
    calls.push({ receiver: this, args: [first, ...rest] });
    return result;
  }
  const target = { spawn: original, spawnSync: original };
  const report: Violation[] = [];
  const deps: SpawnGuardDependencies = {
    target,
    report,
    testFile: "test/setup/example.test.ts",
    loadAllowList: () => new Set(),
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
      return new Set(["test/allowed.test.ts"]);
    },
  });
  expect(guard.target.spawn(["ffmpeg", "-version"])).toBe(guard.result);
  expect(loads).toBe(0);
  file = "test/allowed.test.ts";
  expect(guard.target.spawn(["adb"])).toBe(guard.result);
  file = "test/offender.test.ts";
  expect(() => guard.target.spawn(["adb"])).toThrow("test/offender.test.ts");
  expect(guard.report[0].testFile).toBe(file);
  file = "test/stress/host.test.ts";
  expect(guard.target.spawn(["adb"])).toBe(guard.result);
  expect(loads).toBe(1);
  expect(guard.calls).toHaveLength(3);
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
        /test\/setup\/example\.test\.ts.*adb devices.*FakeProcessExecutor.*unit-test-device-spawn-allowlist\.txt.*only shrink/s,
      );
    }
  }
  expect(guard.calls).toHaveLength(0);
  expect(guard.report).toHaveLength(4);
  guard.restore();
});

test("safe commands preserve receiver, arguments, exact result and function length without loading the list", () => {
  let loads = 0;
  const guard = fakeGuard({
    loadAllowList: () => {
      loads++;
      return new Set();
    },
  });
  const receiver = { example: true };
  const options = { stdout: "pipe" };
  for (const command of ["git", "ps", "bash", "node", "bun", "plutil"]) {
    const argv = [command];
    expect(guard.target.spawn.call(receiver, argv, options)).toBe(guard.result);
    expect(guard.calls.at(-1)).toEqual({ receiver, args: [argv, options] });
  }
  expect(guard.calls).toHaveLength(6);
  expect(guard.target.spawn.length).toBe(guard.original.length);
  expect(loads).toBe(0);
});

test("allow-list is loaded once on demand and permits exact pass-through", () => {
  let loads = 0;
  const guard = fakeGuard({
    loadAllowList: () => {
      loads++;
      return new Set(["test/setup/example.test.ts"]);
    },
  });
  expect(guard.target.spawn(["adb"])).toBe(guard.result);
  expect(guard.target.spawnSync({ cmd: ["xcrun"] })).toBe(guard.result);
  expect(loads).toBe(1);
  expect(guard.report).toHaveLength(0);
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
  expect(() => drainViolations(guard.report)).toThrow("real device tool spawned");
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

describe("Bun child_process interception (imports captured before installation)", () => {
  let dir: string;
  let marker: string;
  let previousPath: string | undefined;
  let restore: () => void;
  const report: Violation[] = [];
  const originals = { spawn: Bun.spawn, spawnSync: Bun.spawnSync };
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
    restore = installRealDeviceToolSpawnGuard({
      target: Bun,
      testFile: "test/setup/example.test.ts",
      loadAllowList: () => new Set(),
      mode: "enforce",
      report,
    });
  });
  afterEach(() => {
    restore();
    Bun.spawn = originals.spawn;
    Bun.spawnSync = originals.spawnSync;
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
