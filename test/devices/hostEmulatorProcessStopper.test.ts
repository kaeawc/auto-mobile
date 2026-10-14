import { expect, test } from "bun:test";
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
  ["leader", `42 42 ${command}`, 99, 42],
  ["daemon in group one", `42 42 ${command}`, 1, 42],
  ["shared", `42 42 ${command}`, 42, undefined],
  ["nonleader", `42 40 ${command}`, 99, undefined],
  ["reused", "42 42 other-command", 99, undefined],
  ["zero", `42 0 ${command}`, 99, undefined],
  ["one", `42 1 ${command}`, 99, undefined],
  ["missing own row", `42 42 ${command}`, undefined, undefined],
] as const) {
  test(`group proof: ${name}`, async () => {
    const f = fixture(`${row}\n${ownGroup === undefined ? "" : `99 ${ownGroup} bun daemon`}\n`);
    expect(await f.signaler.resolveOwnGroup({ pid: 42, command }, { deadlineMs: 10_000 })).toBe(
      expected,
    );
    expect(f.executor.getExecutedCommands()).toEqual(["ps -o pid= -o pgid= -o command= -p 42,99"]);
  });
}
test("hung executor is bounded and returns undefined", async () => {
  const f = fixture("");
  let signal: AbortSignal | undefined;
  f.executor.executeCommand = async (_file, _args, options) => {
    signal = options?.signal;
    return new Promise<never>(() => {});
  };
  expect(
    await f.signaler.resolveOwnGroup({ pid: 42, command }, { deadlineMs: 50 }),
  ).toBeUndefined();
  expect(f.timer.now()).toBe(50);
  expect(signal?.aborted).toBe(true);
});
test("win32 does not invoke ps", async () => {
  const f = fixture(`42 42 ${command}\n99 99 bun`, "win32");
  expect(
    await f.signaler.resolveOwnGroup({ pid: 42, command }, { deadlineMs: 50 }),
  ).toBeUndefined();
  expect(f.executor.getExecutedCommands()).toEqual([]);
});
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
