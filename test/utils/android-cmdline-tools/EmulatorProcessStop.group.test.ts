import { expect, test, spyOn } from "bun:test";
import {
  ProcessTableEmulatorProcessStopper,
  type EmulatorProcessSignaler,
} from "../../../src/utils/android-cmdline-tools/EmulatorProcessStop";
import {
  FakeEmulatorProcessSignaler,
  FakeEmulatorProcessTableSource,
} from "../../fakes/FakeEmulatorProcessStopper";
import { FakeTimer } from "../../fakes/FakeTimer";
import { logger } from "../../../src/utils/logger";

const command = "qemu-system-aarch64 -avd Pixel -port 5554";
const target = { serial: "emulator-5554", avdName: "Pixel" };
class GroupSignaler extends FakeEmulatorProcessSignaler implements EmulatorProcessSignaler {
  readonly groups: { pgid: number; signal: "SIGTERM" | "SIGKILL" }[] = [];
  readonly resolutions: { pid: number; command: string }[] = [];
  group: number | undefined = 42;
  failure: "throw" | "timeout" | undefined;
  probeSignal?: AbortSignal;
  async resolveOwnGroup(
    identity: { pid: number; command: string },
    options: { signal?: AbortSignal; deadlineMs: number },
  ): Promise<number | undefined> {
    this.resolutions.push(identity);
    this.probeSignal = options.signal;
    if (this.failure === "throw") {
      throw new Error("ps unavailable");
    }
    if (this.failure === "timeout") {
      return new Promise<never>(() => {});
    }
    return this.group;
  }
  signalGroup(pgid: number, signal: "SIGTERM" | "SIGKILL"): void {
    this.groups.push({ pgid, signal });
    if (this.errorCode) {
      throw Object.assign(new Error(this.errorCode), { code: this.errorCode });
    }
    if (signal === this.exitOn) {
      this.running = false;
    }
  }
}
function fixture() {
  const table = new FakeEmulatorProcessTableSource();
  table.rows = [{ pid: 42, ppid: 1, command }];
  const signaler = new GroupSignaler();
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  const stopper = new ProcessTableEmulatorProcessStopper(table, signaler, timer, { ownPid: 99 });
  return { table, signaler, timer, stopper };
}
for (const exitOn of ["SIGTERM", "SIGKILL"] as const) {
  test(`own group receives ${exitOn} without any pid signal`, async () => {
    const f = fixture();
    f.signaler.exitOn = exitOn;
    expect(await f.stopper.stop(target, { deadlineMs: 30_000 })).toEqual({
      kind: "stopped",
      pid: 42,
      signal: exitOn,
    });
    expect(f.signaler.groups).toEqual(
      exitOn === "SIGTERM"
        ? [{ pgid: 42, signal: "SIGTERM" }]
        : [
            { pgid: 42, signal: "SIGTERM" },
            { pgid: 42, signal: "SIGKILL" },
          ],
    );
    expect(f.signaler.signals).toEqual([]);
    expect(f.signaler.resolutions).toEqual([{ pid: 42, command }]);
    expect(f.signaler.probes.every((pid) => pid === 42)).toBe(true);
  });
}
for (const failure of [undefined, "throw", "timeout"] as const) {
  test(`unproven group (${failure ?? "shared"}) uses pid only and warns`, async () => {
    const f = fixture();
    f.signaler.group = undefined;
    f.signaler.failure = failure;
    const warn = spyOn(logger, "warn");
    try {
      expect(await f.stopper.stop(target, { deadlineMs: 30_000 })).toMatchObject({
        kind: "stopped",
        signal: "SIGTERM",
      });
      expect(f.signaler.signals).toEqual([{ pid: 42, signal: "SIGTERM" }]);
      expect(f.signaler.groups).toEqual([]);
      expect(warn).toHaveBeenCalled();
      if (failure === "timeout") {
        expect(f.timer.now()).toBeLessThanOrEqual(28_000);
        expect(f.signaler.probeSignal?.aborted).toBe(true);
      }
    } finally {
      warn.mockRestore();
    }
  });
}
test("changed command after group TERM cannot receive group KILL", async () => {
  const f = fixture();
  f.signaler.exitOn = "SIGKILL";
  f.table.results = [
    { value: f.table.rows },
    { value: [{ pid: 42, ppid: 1, command: `${command} -replacement` }] },
  ];
  expect(await f.stopper.stop(target, { deadlineMs: 30_000 })).toMatchObject({
    kind: "stopped",
    signal: "SIGTERM",
  });
  expect(f.signaler.groups).toEqual([{ pgid: 42, signal: "SIGTERM" }]);
  expect(f.signaler.signals).toEqual([]);
});
test("group ESRCH counts as exited", async () => {
  const f = fixture();
  f.signaler.errorCode = "ESRCH";
  expect(await f.stopper.stop(target, { deadlineMs: 30_000 })).toMatchObject({
    kind: "stopped",
    signal: "SIGTERM",
  });
  expect(f.signaler.signals).toEqual([]);
});
