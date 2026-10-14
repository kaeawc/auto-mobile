import { expect, test, spyOn } from "bun:test";
import {
  ProcessTableEmulatorProcessStopper,
  type EmulatorProcessSignaler,
  type EmulatorGroupProbe,
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
  probe: EmulatorGroupProbe = { kind: "own-group", pgid: 42 };
  failure: "throw" | "timeout" | undefined;
  probeSignal?: AbortSignal;
  async resolveOwnGroup(
    identity: { pid: number; command: string },
    options: { signal?: AbortSignal; deadlineMs: number },
  ): Promise<EmulatorGroupProbe> {
    this.resolutions.push(identity);
    this.probeSignal = options.signal;
    if (this.failure === "throw") {
      throw new Error("ps unavailable");
    }
    if (this.failure === "timeout") {
      return new Promise<never>(() => {});
    }
    return this.probe;
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
  test(`unproven group (${failure ?? "result"}) uses pid only and warns`, async () => {
    const f = fixture();
    f.signaler.probe = { kind: "unproven" };
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
        expect(f.timer.now()).toBe(28_000);
        expect(f.signaler.probeSignal?.aborted).toBe(true);
      }
    } finally {
      warn.mockRestore();
    }
  });
}
for (const exitOn of ["SIGTERM", "SIGKILL"] as const) {
  test(`shared group uses pid-only ${exitOn} without warning`, async () => {
    const f = fixture();
    f.signaler.probe = { kind: "shared" };
    f.signaler.exitOn = exitOn;
    const warn = spyOn(logger, "warn");
    try {
      expect(await f.stopper.stop(target, { deadlineMs: 30_000 })).toEqual({
        kind: "stopped",
        pid: 42,
        signal: exitOn,
      });
      expect(f.signaler.signals).toEqual(
        exitOn === "SIGTERM"
          ? [{ pid: 42, signal: "SIGTERM" }]
          : [
              { pid: 42, signal: "SIGTERM" },
              { pid: 42, signal: "SIGKILL" },
            ],
      );
      expect(f.signaler.groups).toEqual([]);
      expect(warn).not.toHaveBeenCalled();
    } finally {
      warn.mockRestore();
    }
  });
}
test("absent probe leaves the pid untouched without polling for exit", async () => {
  const f = fixture();
  f.signaler.probe = { kind: "absent" };
  const warn = spyOn(logger, "warn");
  try {
    expect(await f.stopper.stop(target, { deadlineMs: 30_000 })).toEqual({
      kind: "stopped",
      pid: 42,
      signal: "SIGTERM",
    });
    expect(f.signaler.signals).toEqual([]);
    expect(f.signaler.groups).toEqual([]);
    expect(f.signaler.probes).toEqual([]);
    expect(f.timer.getSleepHistory()).toEqual([]);
    expect(f.table.calls).toHaveLength(1);
    expect(warn).toHaveBeenCalledWith(
      "[EmulatorProcessStop] pid 42 disappeared or changed command before SIGTERM; leaving its replacement untouched",
    );
  } finally {
    warn.mockRestore();
  }
});
test("probe exhausting the remaining budget still dispatches pid-only TERM", async () => {
  const f = fixture();
  f.signaler.failure = "timeout";
  const signalTimes: number[] = [];
  const signal = f.signaler.signal.bind(f.signaler);
  f.signaler.signal = (pid, kind) => {
    signalTimes.push(f.timer.now());
    signal(pid, kind);
  };
  expect(await f.stopper.stop(target, { deadlineMs: 2500 })).toEqual({
    kind: "stopped",
    pid: 42,
    signal: "SIGTERM",
  });
  expect(signalTimes).toEqual([500]);
  expect(f.signaler.signals).toEqual([{ pid: 42, signal: "SIGTERM" }]);
  expect(f.signaler.groups).toEqual([]);
  expect(f.signaler.probeSignal?.aborted).toBe(true);
});
test("caller abort during group probe propagates without signalling", async () => {
  const f = fixture();
  f.signaler.failure = "timeout";
  const controller = new AbortController();
  const reason = new Error("caller cancelled");
  f.timer.setTimeout(() => controller.abort(reason), 50);
  await expect(
    f.stopper.stop(target, { deadlineMs: 30_000, signal: controller.signal }),
  ).rejects.toBe(reason);
  expect(f.signaler.signals).toEqual([]);
  expect(f.signaler.groups).toEqual([]);
  expect(f.signaler.probeSignal?.aborted).toBe(true);
});
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
