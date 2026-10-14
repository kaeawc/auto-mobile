import { expect, test, spyOn } from "bun:test";
import {
  HostEmulatorProcessSignaler,
  createHostEmulatorProcessStopper,
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
import { ProcessTableReader } from "../../src/features/bootAdmission/processTableRetry";
import { defaultLockOwnerGenerationProbe } from "../../src/daemon/lockOwnerGeneration";
import { FakeLockOwnerGenerationProbe } from "../fakes/FakeLockOwnerGenerationProbe";
const command = "/My SDK/emulator/qemu-system-aarch64 -avd Pixel -port 5554";
for (const group of ["own-group", "shared"] as const) {
  test(`factory generation guard withholds ${group} KILL for a recycled pid`, async () => {
    const f = fixture(`42 42 ${command}\n99 ${group === "own-group" ? 99 : 42} bun daemon`);
    let tableReads = 0;
    f.executor.executeCommand = async (_file, args) => {
      if (args?.includes("-axo")) {
        tableReads++;
        return createExecResult(`42 1 100 0.0 ${command}`, "");
      }
      return createExecResult(
        `42 42 ${command}\n99 ${group === "own-group" ? 99 : 42} bun daemon`,
        "",
      );
    };
    const generation = new FakeLockOwnerGenerationProbe();
    generation.onCompare = () => (tableReads === 2 ? "different" : "same");
    const kill = spyOn(process, "kill").mockImplementation(() => true);
    try {
      const stopper = createHostEmulatorProcessStopper({
        executor: f.executor,
        timer: f.timer,
        processGeneration: generation,
        ownPid: 99,
        platform: "darwin",
      });
      expect(
        await stopper.stop({ serial: "emulator-5554", avdName: "Pixel" }, { deadlineMs: 30_000 }),
      ).toEqual({
        kind: "stopped",
        pid: 42,
        signal: "SIGTERM",
      });
      expect(tableReads).toBe(2);
      expect(generation.currentCalls).toEqual([42]);
      expect(generation.compareCalls.at(-1)).toEqual({ pid: 42, recorded: generation.token });
      expect(kill.mock.calls.filter(([, signal]) => signal !== 0)).toEqual([
        [group === "own-group" ? -42 : 42, "SIGTERM"],
      ]);
    } finally {
      kill.mockRestore();
    }
  });
}
test("memoized host stopper captures and compares the default generation probe", async () => {
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const table = spyOn(ProcessTableReader.prototype, "read").mockResolvedValue({
    value: [{ pid: 42, ppid: 1, command }],
  });
  const group = spyOn(HostEmulatorProcessSignaler.prototype, "resolveOwnGroup").mockResolvedValue({
    kind: "own-group",
    pgid: 42,
  });
  const kill = spyOn(process, "kill").mockImplementation(() => true);
  const current = spyOn(defaultLockOwnerGenerationProbe, "current").mockReturnValue("recorded");
  const compare = spyOn(defaultLockOwnerGenerationProbe, "compare").mockReturnValue("different");
  try {
    const stopper = getHostEmulatorProcessStopper(timer);
    expect(
      await stopper.stop({ serial: "emulator-5554", avdName: "Pixel" }, { deadlineMs: 30_000 }),
    ).toEqual({ kind: "stopped", pid: 42, signal: "SIGTERM" });
    expect(current.mock.calls).toEqual([[42]]);
    expect(compare.mock.calls).toEqual([[42, "recorded"]]);
    expect(kill.mock.calls).toEqual([
      [-42, "SIGTERM"],
      [42, 0],
    ]);
    expect(table).toHaveBeenCalledTimes(1);
    expect(group).toHaveBeenCalledTimes(1);
  } finally {
    compare.mockRestore();
    current.mockRestore();
    kill.mockRestore();
    group.mockRestore();
    table.mockRestore();
  }
});
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
