import { expect, test } from "bun:test";
import { join } from "node:path";
import { bootGate, type BootGateCommand } from "../../scripts/manual-test/bootGate";
import {
  parsePrivateDaemonArgs,
  runPrivateDaemonCommand,
} from "../../scripts/manual-test/private-daemon";
import { fixture, options, parsed } from "./manualTestPrivateDaemonFixture";
import { FakeTimer } from "../fakes/FakeTimer";
const root = join(options.batchDir, "shared/boot-gate");
const grantPath = join(root, "last-grant.json");
function gateFixture() {
  const f = fixture();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  f.deps.timer = timer;
  const locks = new Set<string>();
  const releases: string[] = [];
  f.deps.bootLock = {
    tryAcquire: (path) => {
      if (locks.has(path)) {
        return false;
      }
      locks.add(path);
      return true;
    },
    release: (path) => {
      releases.push(path);
      locks.delete(path);
    },
  };
  return { ...f, timer, locks, releases };
}
function gate(overrides: Partial<BootGateCommand> = {}): BootGateCommand {
  return {
    op: "boot-gate",
    batchDir: options.batchDir,
    role: "A1",
    maxConcurrent: 1,
    minIntervalMs: 0,
    timeoutMs: 100,
    pollMs: 10,
    command: [],
    ...overrides,
  };
}
function document(f: { logs: string[] }) {
  return JSON.parse(f.logs.at(-1)!);
}
test("grants immediately, records epoch and role, warns permit ends at exit", async () => {
  const f = gateFixture();
  expect(await bootGate(gate(), f.deps)).toBe(0);
  expect(document(f)).toMatchObject({
    role: "A1",
    outcome: "granted",
    permit: 0,
    waitedMs: 0,
    loadAverage1m: 0,
    maxLoad: 16,
    note: expect.stringContaining("not held past exit"),
  });
  expect(JSON.parse(f.files.get(grantPath)!)).toEqual({ at: 0, role: "A1" });
  expect(f.locks.size).toBe(0);
  expect(f.releases).toEqual([join(root, "permit-0.lock")]);
  expect(f.timer.getSleepHistory()).toEqual([]);
  expect(document(f)).not.toHaveProperty("slot");
});
test("second role polls a held single permit and grants after first command releases", async () => {
  const f = gateFixture();
  const command = f.deps.runCommand;
  f.deps.runCommand = async (...args) => {
    expect(f.locks.has(join(root, "permit-0.lock"))).toBe(true);
    await f.timer.sleep(20);
    return command(...args);
  };
  const first = bootGate(gate({ command: ["boot-device"] }), f.deps);
  const second = bootGate(gate({ role: "A2" }), f.deps);
  expect(await first).toBe(0);
  expect(await second).toBe(0);
  expect(document(f)).toMatchObject({ role: "A2", outcome: "granted", waitedMs: 20 });
  expect(f.timer.getSleepHistory().filter((ms) => ms !== 20)).toEqual([10, 10]);
  expect(f.releases).toHaveLength(2);
});
test("load threshold is strict and polls until load falls", async () => {
  const f = gateFixture();
  const stats = f.deps.hostStats();
  f.deps.hostStats = () => ({ ...stats, loadAverage: [f.timer.now() < 20 ? 3 : 2, 0, 0] });
  expect(await bootGate(gate({ maxLoad: 3 }), f.deps)).toBe(0);
  expect(document(f)).toMatchObject({ waitedMs: 20, loadAverage1m: 2, maxLoad: 3 });
  expect(f.timer.getSleepHistory()).toEqual([10, 10]);
});
test("waits minimum interval while holding permit", async () => {
  const f = gateFixture();
  f.files.set(grantPath, JSON.stringify({ at: 0, role: "previous" }));
  expect(await bootGate(gate({ minIntervalMs: 30 }), f.deps)).toBe(0);
  expect(document(f).waitedMs).toBe(30);
  expect(f.timer.getSleepHistory()).toEqual([10, 10, 10]);
});
test.each(["garbage", '{"at":"bad","role":"A"}', '{"at":0}'])(
  "corrupt grant %s is no previous grant",
  async (text) => {
    const f = gateFixture();
    f.files.set(grantPath, text);
    expect(await bootGate(gate({ minIntervalMs: 30000 }), f.deps)).toBe(0);
    expect(f.timer.getSleepHistory()).toEqual([]);
  },
);
test("two-permit gate takes second permit when first is held", async () => {
  const f = gateFixture();
  f.locks.add(join(root, "permit-0.lock"));
  expect(await bootGate(gate({ maxConcurrent: 2 }), f.deps)).toBe(0);
  expect(document(f).permit).toBe(1);
  expect(f.releases).toEqual([join(root, "permit-1.lock")]);
  expect(f.locks.has(join(root, "permit-0.lock"))).toBe(true);
});
test.each([0, 7])(
  "command holds permit and returns exit %i with own environment",
  async (exitCode) => {
    const f = gateFixture();
    f.deps.env = { KEEP: "own", AUTOMOBILE_DB_PATH: "/own/path", OMIT: undefined };
    f.deps.logSinkOverride = [];
    f.deps.runCommand = async (command, args, env) => {
      expect(f.locks.size).toBe(1);
      expect(command).toBe("boot");
      expect(args).toEqual(["--port", "3000"]);
      expect(env).toEqual({ KEEP: "own", AUTOMOBILE_DB_PATH: "/own/path" });
      return { exitCode };
    };
    expect(await bootGate(gate({ command: ["boot", "--port", "3000"] }), f.deps)).toBe(exitCode);
    expect(document(f)).not.toHaveProperty("note");
    expect(f.locks.size).toBe(0);
  },
);
test("command rejection releases permit and CLI reports I/O exit 2", async () => {
  const f = gateFixture();
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  f.deps.runCommand = async () => {
    expect(f.locks.size).toBe(1);
    throw new Error("command rejected");
  };
  expect(await runPrivateDaemonCommand(gate({ command: ["boot"] }), f.deps)).toBe(2);
  expect(f.locks.size).toBe(0);
  expect(f.logs.at(-1)).toContain("command rejected");
});
test.each(["permit", "load", "interval"] as const)(
  "%s timeout releases only own permit and never runs command",
  async (waitingFor) => {
    const f = gateFixture();
    if (waitingFor === "permit") {
      f.locks.add(join(root, "permit-0.lock"));
    }
    if (waitingFor === "load") {
      const stats = f.deps.hostStats();
      f.deps.hostStats = () => ({ ...stats, loadAverage: [20, 0, 0] });
    }
    if (waitingFor === "interval") {
      f.files.set(grantPath, JSON.stringify({ at: 0, role: "previous" }));
    }
    expect(
      await bootGate(gate({ timeoutMs: 30, minIntervalMs: 100, command: ["boot"] }), f.deps),
    ).toBe(2);
    expect(document(f)).toMatchObject({
      outcome: "timeout",
      waitingFor,
      waitedMs: 30,
      maxLoad: 16,
    });
    expect(f.timer.getSleepHistory()).toEqual([10, 10, 10]);
    expect(f.launches).toEqual([]);
    expect(f.releases).toHaveLength(waitingFor === "permit" ? 0 : 1);
  },
);
test("boot gate needs initialized batch; wrapped tokens bypass daemon flags", async () => {
  const f = gateFixture();
  const command = parsed([
    "boot-gate",
    "--batch-dir",
    options.batchDir,
    "--role",
    "A1",
    "--",
    "boot",
    "--port",
    "3000",
    "--strict-port",
    "--batch-dir",
    "own",
  ]);
  expect(command).toMatchObject({
    command: ["boot", "--port", "3000", "--strict-port", "--batch-dir", "own"],
    maxConcurrent: 1,
    maxLoad: undefined,
    minIntervalMs: 30000,
    timeoutMs: 600000,
    pollMs: 2000,
  });
  expect(command).not.toHaveProperty("extraFlags");
  expect(await runPrivateDaemonCommand(command, f.deps)).toBe(2);
  expect(f.releases).toEqual([]);
  await runPrivateDaemonCommand({ op: "init", options }, f.deps);
  expect(await runPrivateDaemonCommand(command, f.deps)).toBe(0);
  expect(f.launches[0].args).toEqual(["--port", "3000", "--strict-port", "--batch-dir", "own"]);
});
test.each([
  ["--role", "bad role"],
  ["--role", "a".repeat(65)],
  ["--role", "../"],
  ["--role", ""],
  ["--max-concurrent", "0"],
  ["--max-concurrent", "9"],
  ["--max-concurrent", "1.2"],
  ["--max-load", "0"],
  ["--max-load", "-1"],
  ["--max-load", "NaN"],
  ["--max-load", "Infinity"],
  ["--min-interval-ms", "-1"],
  ["--timeout-ms", "0"],
  ["--poll-ms", "0"],
  ["--poll-ms", "x"],
  ["--timeout-ms", "1.2"],
])("rejects invalid %s=%s", (flag, value) => {
  const args = [
    "boot-gate",
    "--batch-dir",
    options.batchDir,
    ...(flag === "--role" ? [] : ["--role", "A1"]),
    flag,
    value,
  ];
  expect(parsePrivateDaemonArgs(args)).toHaveProperty("error");
});
test("valid role and fractional max load; missing role and empty passthrough refused", () => {
  expect(
    parsed(["boot-gate", "--batch-dir", options.batchDir, "--role", "A_1.2-3", "--max-load", "0.5"])
      .op,
  ).toBe("boot-gate");
  expect(parsePrivateDaemonArgs(["boot-gate", "--batch-dir", options.batchDir])).toHaveProperty(
    "error",
  );
  expect(
    parsePrivateDaemonArgs(["boot-gate", "--batch-dir", options.batchDir, "--role", "A1", "--"]),
  ).toHaveProperty("error");
  for (const op of [
    "init",
    "stop",
    "status",
    "env",
    "wrappers",
    "devices",
    "shutdown-devices",
    "preflight",
  ]) {
    expect(
      parsePrivateDaemonArgs([op, "--batch-dir", options.batchDir, "--", "command"]),
    ).toHaveProperty("error");
  }
});

test("deadline does not grant when load falls exactly at deadline", async () => {
  const f = gateFixture();
  const stats = f.deps.hostStats();
  f.deps.hostStats = () => ({ ...stats, loadAverage: [f.timer.now() < 30 ? 20 : 0, 0, 0] });
  expect(await bootGate(gate({ timeoutMs: 30, command: ["boot"] }), f.deps)).toBe(2);
  expect(document(f)).toMatchObject({ waitingFor: "load", waitedMs: 30 });
  expect(f.launches).toEqual([]);
  expect(f.locks.size).toBe(0);
});
