import { expect, test, spyOn } from "bun:test";
import {
  HostEmulatorProcessSignaler,
  getHostEmulatorProcessStopper,
} from "../../src/devices/hostEmulatorProcessStopper";
import {
  getDeviceToolsDependencies,
  resetDeviceToolsDependencies,
  setDeviceToolsDependencies,
} from "../../src/server/deviceTools";
import { FakeHostCommandExecutor } from "../fakes/FakeHostCommandExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { createExecResult } from "../../src/utils/execResult";
import { logger } from "../../src/utils/logger";
const command = "/My SDK/emulator/qemu-system-aarch64 -avd Pixel -port 5554";
function fixture(stdout: string, platform: NodeJS.Platform = "darwin") {
  const executor = new FakeHostCommandExecutor();
  executor.setDefaultResponse(createExecResult(stdout, ""));
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const signaler = new HostEmulatorProcessSignaler(executor, timer, { ownPid: 99, platform });
  return { executor, timer, signaler };
}
for (const [name, row, ownGroup, expected] of [
  ["leader", `42 42 ${command}`, 99, { kind: "own-group", pgid: 42 }],
  ["daemon in group one", `42 42 ${command}`, 1, { kind: "own-group", pgid: 42 }],
  ["shared", `42 42 ${command}`, 42, { kind: "shared" }],
  ["nonleader", `42 40 ${command}`, 99, { kind: "shared" }],
  ["reused", "42 42 other-command", 99, { kind: "absent" }],
  ["gone", "", 99, { kind: "absent" }],
  ["zero", `42 0 ${command}`, 99, { kind: "shared" }],
  ["one", `42 1 ${command}`, 99, { kind: "shared" }],
  ["missing own row", `42 42 ${command}`, undefined, { kind: "unproven" }],
  ["invalid daemon group", `42 42 ${command}`, 0, { kind: "unproven" }],
  ["garbage", "garbage", 99, { kind: "unproven" }],
  ["empty command", "42 42   ", 99, { kind: "unproven" }],
  ["partly malformed", `42 42 ${command}\ngarbage`, 99, { kind: "unproven" }],
  ["duplicate target", `42 42 ${command}\n42 42 ${command}`, 99, { kind: "unproven" }],
  ["duplicate daemon", `42 42 ${command}\n99 99 bun daemon`, 99, { kind: "unproven" }],
  ["unsafe integer", `42 9007199254740992 ${command}`, 99, { kind: "unproven" }],
] as const) {
  test(`group proof: ${name}`, async () => {
    const f = fixture(`${row}\n${ownGroup === undefined ? "" : `99 ${ownGroup} bun daemon`}\n`);
    expect(await f.signaler.resolveOwnGroup({ pid: 42, command }, { deadlineMs: 10_000 })).toEqual(
      expected,
    );
    expect(f.executor.getExecutedCommands()).toEqual(["ps -o pid= -o pgid= -o command= -p 42,99"]);
  });
}
for (const deadlineMs of [50, 10_000]) {
  test(`hung executor is bounded to ${Math.min(500, deadlineMs)}ms and returns unproven`, async () => {
    const f = fixture("");
    let signal: AbortSignal | undefined;
    let timeoutMs: number | undefined;
    f.executor.executeCommand = async (_file, _args, options) => {
      signal = options?.signal;
      timeoutMs = options?.timeoutMs;
      return new Promise<never>(() => {});
    };
    const warn = spyOn(logger, "warn");
    try {
      expect(await f.signaler.resolveOwnGroup({ pid: 42, command }, { deadlineMs })).toEqual({
        kind: "unproven",
      });
      expect(f.timer.now()).toBe(Math.min(500, deadlineMs));
      expect(timeoutMs).toBe(Math.min(500, deadlineMs));
      expect(signal?.aborted).toBe(true);
      expect(warn).toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
}
test("executor failure returns unproven and logs the error", async () => {
  const f = fixture("");
  const failure = new Error("ps unavailable");
  f.executor.executeCommand = async () => {
    throw failure;
  };
  const warn = spyOn(logger, "warn");
  try {
    expect(await f.signaler.resolveOwnGroup({ pid: 42, command }, { deadlineMs: 50 })).toEqual({
      kind: "unproven",
    });
    expect(warn.mock.calls[0]?.[0]).toBe(
      "[EmulatorProcessStop] group probe failed for pid 42: ps unavailable",
    );
    expect(warn.mock.calls[0]?.[1]).toBe(failure);
  } finally {
    warn.mockRestore();
  }
});
test("caller abort interrupts the host probe", async () => {
  const f = fixture("");
  const controller = new AbortController();
  let signal: AbortSignal | undefined;
  f.executor.executeCommand = async (_file, _args, options) => {
    signal = options?.signal;
    controller.abort(new Error("caller cancelled"));
    return new Promise<never>(() => {});
  };
  expect(
    await f.signaler.resolveOwnGroup(
      { pid: 42, command },
      {
        deadlineMs: 10_000,
        signal: controller.signal,
      },
    ),
  ).toEqual({ kind: "unproven" });
  expect(signal?.aborted).toBe(true);
  expect(f.timer.now()).toBe(0);
});
test("spent deadline returns unproven without invoking ps", async () => {
  const f = fixture("");
  expect(await f.signaler.resolveOwnGroup({ pid: 42, command }, { deadlineMs: 0 })).toEqual({
    kind: "unproven",
  });
  expect(f.executor.getExecutedCommands()).toEqual([]);
});
test("win32 does not invoke ps", async () => {
  const f = fixture(`42 42 ${command}\n99 99 bun`, "win32");
  expect(await f.signaler.resolveOwnGroup({ pid: 42, command }, { deadlineMs: 50 })).toEqual({
    kind: "unproven",
  });
  expect(f.executor.getExecutedCommands()).toEqual([]);
});
for (const pid of [0, 1, 99, -1, 2.5, Number.NaN, Number.MAX_SAFE_INTEGER + 1]) {
  test(`unsafe pid ${pid} does not invoke ps`, async () => {
    const f = fixture("");
    expect(await f.signaler.resolveOwnGroup({ pid, command }, { deadlineMs: 50 })).toEqual({
      kind: "unproven",
    });
    expect(f.executor.getExecutedCommands()).toEqual([]);
  });
}
test("host stopper is lazy and memoized per timer", () => {
  const timer = new FakeTimer();
  const otherTimer = new FakeTimer();
  const stopper = getHostEmulatorProcessStopper(timer);
  expect(getHostEmulatorProcessStopper(timer)).toBe(stopper);
  expect(getHostEmulatorProcessStopper(otherTimer)).not.toBe(stopper);
  expect(getHostEmulatorProcessStopper()).toBe(getHostEmulatorProcessStopper());
  expect(getHostEmulatorProcessStopper()).not.toBe(stopper);
});
test("host stopper is shared with the tool dependency for its timer", () => {
  resetDeviceToolsDependencies();
  try {
    const timer = new FakeTimer();
    setDeviceToolsDependencies({ timer });
    expect(getDeviceToolsDependencies().androidEmulatorProcessStopper).toBe(
      getHostEmulatorProcessStopper(timer),
    );
    resetDeviceToolsDependencies();
    expect(getDeviceToolsDependencies().androidEmulatorProcessStopper).toBe(
      getHostEmulatorProcessStopper(),
    );
  } finally {
    resetDeviceToolsDependencies();
  }
});
