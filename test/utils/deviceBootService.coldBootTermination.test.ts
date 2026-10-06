import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "bun:test";
import { SURVIVING_PROCESS_RECHECK_INTERVAL_MS } from "../../src/devices/coldBootProcessTermination";
import { DeviceBootService } from "../../src/devices/deviceBootService";
import {
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleLease,
} from "../../src/devices/virtualDeviceLifecycleCoordinator";
import type { BootedDevice, DeviceInfo } from "../../src/models";
import { EmulatorLaunchCancelledError } from "../../src/models/EmulatorLaunchCancelledError";
import { getAbortSignal } from "../../src/utils/AbortContext";
import { FakeDeviceMatcher } from "../fakes/FakeDeviceMatcher";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";

// #9901: a failed or cancelled cold boot must confirm the emulator it started
// is gone before the AVD's lifecycle lease is released.

const image: DeviceInfo = {
  name: "Pixel_9_API_35",
  platform: "android",
  isRunning: false,
  osVersion: "35",
};
const GRACE_MS = 1_000;
const SURVIVOR_RECHECK_MS = SURVIVING_PROCESS_RECHECK_INTERVAL_MS;
const PID = 4242;

class BootFailure extends Error {}

type FakeEmulator = ChildProcess & { exitCode: number | null; signalCode: NodeJS.Signals | null };

/** A process that only exits when the test says so; records every signal it is sent. */
function fakeEmulator(): { process: FakeEmulator; signals: string[]; exit: () => void } {
  const process = new EventEmitter() as FakeEmulator;
  const signals: string[] = [];
  process.exitCode = null;
  process.signalCode = null;
  process.pid = PID;
  process.kill = (signal?: NodeJS.Signals | number) => {
    signals.push(String(signal ?? "SIGTERM"));
    return true;
  };
  const exit = () => {
    process.signalCode = "SIGKILL";
    process.emit("exit", null, "SIGKILL");
  };
  return { process, signals, exit };
}

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

function setup() {
  const devices = new FakeDeviceUtils();
  const matcher = new FakeDeviceMatcher();
  const timer = new FakeTimer();
  const coordinator = new InMemoryVirtualDeviceLifecycleCoordinator(timer);
  const emulator = fakeEmulator();
  const retained: Promise<void>[] = [];
  // A stand-in for process.kill(pid, 0): no test ever probes a real pid.
  const liveness = { running: true, probed: [] as number[] };
  devices.setDeviceImages("android", [image]);
  matcher.setImageResult(image);
  devices.setMockChildProcess(image.name, emulator.process);
  const boot = (
    lifecycleLease?: VirtualDeviceLifecycleLease,
    signal?: AbortSignal,
    canRetainLease = true,
    options: { cleanupMayOutliveRequest?: boolean; timeoutMs?: number } = {},
  ) =>
    new DeviceBootService({
      deviceManager: devices,
      deviceMatcher: matcher,
      deviceCreationGate: { isCreationAllowed: () => false, describeSource: () => "test" },
      deviceProvisioner: {
        provision: async () => {
          throw new Error("unexpected provision");
        },
      },
      matchingStrategy: "LATEST",
      timer,
      lifecycleCoordinator: coordinator,
      lifecycleLease,
      retainLeaseUntil: canRetainLease ? (settlement) => retained.push(settlement) : undefined,
      cleanupMayOutliveRequest: options.cleanupMayOutliveRequest ?? true,
      isProcessRunning: (pid) => {
        liveness.probed.push(pid);
        return liveness.running;
      },
    }).boot({ platform: "android", signal, timeoutMs: options.timeoutMs });
  // A second request for the same AVD: granted only once the first lease is released.
  const refusals: unknown[] = [];
  const nextRequestForAvd = () => {
    let granted = false;
    void coordinator
      .reserve(
        { kind: "stable", platform: "android", stableId: image.name },
        { operation: "start", deadlineMs: 60_000 },
      )
      .then(
        () => {
          granted = true;
        },
        (error: unknown) => {
          refusals.push(error);
        },
      );
    return () => granted;
  };
  return {
    devices,
    matcher,
    timer,
    coordinator,
    emulator,
    retained,
    liveness,
    refusals,
    boot,
    nextRequestForAvd,
  };
}

function track(promise: Promise<unknown>): { error: () => unknown; settled: () => boolean } {
  let error: unknown;
  let settled = false;
  promise.then(
    () => {
      settled = true;
    },
    (reason: unknown) => {
      error = reason;
      settled = true;
    },
  );
  return { error: () => error, settled: () => settled };
}

describe("DeviceBootService owned cold-boot termination (#9901)", () => {
  it("holds the lease until a process that exits on SIGTERM is confirmed gone", async () => {
    const t = setup();
    t.devices.setWaitForDeviceReadyError(new Error("never reached sys.boot_completed"));
    const outcome = track(t.boot());
    await settle();

    expect(t.emulator.signals).toEqual(["SIGTERM"]);
    // SIGTERM has been sent but `exit` has not fired: the AVD is still held.
    expect(outcome.settled()).toBe(false);
    const nextGranted = t.nextRequestForAvd();
    await settle();
    expect(nextGranted()).toBe(false);

    t.emulator.exit();
    await settle();

    expect(outcome.settled()).toBe(true);
    expect(String((outcome.error() as Error).message)).toContain(
      "never reached sys.boot_completed",
    );
    expect(t.emulator.signals).toEqual(["SIGTERM"]);
    expect(nextGranted()).toBe(true);
  });

  it("escalates to SIGKILL after the bounded wait, then releases the lease on exit", async () => {
    const t = setup();
    t.devices.setWaitForDeviceReadyError(new Error("boot wedged"));
    const outcome = track(t.boot());
    await settle();
    const nextGranted = t.nextRequestForAvd();

    t.timer.advanceTime(GRACE_MS);
    await settle();

    expect(t.emulator.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(outcome.settled()).toBe(false);
    expect(nextGranted()).toBe(false);

    t.emulator.exit();
    await settle();

    expect(outcome.settled()).toBe(true);
    expect(nextGranted()).toBe(true);
    expect(t.retained).toHaveLength(0);
  });

  it("reports the original error naming the pid and keeps the lease when SIGKILL is ignored", async () => {
    const t = setup();
    t.devices.setWaitForDeviceReadyError(new Error("boot wedged"));
    const outcome = track(t.boot());
    await settle();

    t.timer.advanceTime(GRACE_MS);
    await settle();
    t.timer.advanceTime(GRACE_MS);
    await settle();

    expect(outcome.settled()).toBe(true);
    const message = String((outcome.error() as Error).message);
    expect(message).toContain("boot wedged");
    expect(message).toContain(String(PID));
    expect(message).toContain("did not exit after SIGTERM and SIGKILL");
    expect(t.emulator.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(t.retained).toHaveLength(1);
    // The AVD is not handed to a retry as if it were free: the retry is told why, at once.
    const nextGranted = t.nextRequestForAvd();
    await settle();
    expect(nextGranted()).toBe(false);
    expect(String((t.refusals[0] as Error).message)).toContain(`held by unkillable process ${PID}`);

    // The survivor finally dies: only now is the lease released.
    t.emulator.exit();
    await settle();
    const afterExit = t.nextRequestForAvd();
    await settle();
    expect(afterExit()).toBe(true);
  });

  it("applies the same ordering when the caller aborts during boot", async () => {
    const t = setup();
    const controller = new AbortController();
    t.devices.waitForDeviceReady = async () => await new Promise<BootedDevice>(() => {});
    const outcome = track(t.boot(undefined, controller.signal));
    await settle();
    const nextGranted = t.nextRequestForAvd();

    controller.abort(new Error("request cancelled"));
    await settle();
    expect(t.emulator.signals).toEqual(["SIGTERM"]);
    expect(nextGranted()).toBe(false);

    t.timer.advanceTime(GRACE_MS);
    await settle();
    expect(t.emulator.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(nextGranted()).toBe(false);

    t.emulator.exit();
    await settle();

    expect(outcome.settled()).toBe(true);
    expect(nextGranted()).toBe(true);
  });

  it("hands an injected lease's owner the survivor's exit instead of releasing it", async () => {
    const t = setup();
    t.devices.setWaitForDeviceReadyError(new Error("boot wedged"));
    const lease = await t.coordinator.reserve(
      { kind: "stable", platform: "android", stableId: image.name },
      { operation: "start", deadlineMs: 60_000 },
    );
    const outcome = track(t.boot(lease));
    await settle();
    t.timer.advanceTime(GRACE_MS);
    await settle();
    t.timer.advanceTime(GRACE_MS);
    await settle();

    expect(outcome.settled()).toBe(true);
    expect(t.retained).toHaveLength(1);
    let exited = false;
    void t.retained[0].then(() => {
      exited = true;
    });
    await settle();
    expect(exited).toBe(false);
    t.emulator.exit();
    await settle();
    expect(exited).toBe(true);
    lease.release();
  });

  it("keeps the boot's own error and says the AVD was released when the exit cannot be observed", async () => {
    const t = setup();
    const failure = new BootFailure("boot wedged");
    t.devices.setWaitForDeviceReadyError(failure);
    t.emulator.process.once = () => {
      throw new Error("exit listener registration failed");
    };
    const outcome = track(t.boot());
    await settle();

    expect(outcome.settled()).toBe(true);
    const thrown = outcome.error() as BootFailure;
    expect(thrown.message).toContain("boot wedged");
    // The lease is released at once, so the note must not claim the AVD stays reserved.
    expect(thrown.message).toContain("could not be observed");
    expect(thrown.message).toContain("AVD was released");
    expect(thrown.message).not.toContain("stays reserved");
    const next = t.nextRequestForAvd();
    await settle();
    expect(next()).toBe(true);
  });

  it("annotates a copy of the failure and leaves the original error object untouched", async () => {
    const t = setup();
    const failure = new BootFailure("boot wedged");
    t.devices.setWaitForDeviceReadyError(failure);
    const outcome = track(t.boot());
    await settle();
    t.timer.advanceTime(GRACE_MS);
    await settle();
    t.timer.advanceTime(GRACE_MS);
    await settle();

    const thrown = outcome.error();
    expect(thrown).toBeInstanceOf(BootFailure);
    expect(thrown).not.toBe(failure);
    expect((thrown as BootFailure).message).toContain("did not exit after SIGTERM and SIGKILL");
    expect(failure.message).toBe("boot wedged");
  });

  it("releases the lease once a periodic liveness re-check finds the survivor's pid gone", async () => {
    const t = setup();
    t.devices.setWaitForDeviceReadyError(new Error("boot wedged"));
    const outcome = track(t.boot());
    await settle();
    t.timer.advanceTime(GRACE_MS);
    await settle();
    t.timer.advanceTime(GRACE_MS);
    await settle();
    expect(outcome.settled()).toBe(true);
    expect(t.liveness.probed).toEqual([]);

    // Still alive after a full interval: the hold stays and is reported, not waited on.
    t.timer.advanceTime(SURVIVOR_RECHECK_MS);
    await settle();
    expect(t.liveness.probed).toEqual([PID]);
    const whileAlive = t.nextRequestForAvd();
    await settle();
    expect(whileAlive()).toBe(false);
    expect(t.refusals).toHaveLength(1);

    // The pid vanishes without an exit event ever firing.
    t.liveness.running = false;
    t.timer.advanceTime(SURVIVOR_RECHECK_MS);
    await settle();
    const afterGone = t.nextRequestForAvd();
    await settle();
    expect(afterGone()).toBe(true);
    // The watch stops re-checking once it has released the lease.
    const probes = t.liveness.probed.length;
    t.timer.advanceTime(SURVIVOR_RECHECK_MS * 3);
    await settle();
    expect(t.liveness.probed).toHaveLength(probes);
    expect(t.timer.getPendingTimeoutCount()).toBe(0);
  });

  it("refuses a start queued behind the AVD the moment its emulator proves unkillable", async () => {
    const t = setup();
    t.devices.setWaitForDeviceReadyError(new Error("boot wedged"));
    const outcome = track(t.boot());
    await settle();
    const queued = t.nextRequestForAvd();
    await settle();
    expect(t.refusals).toHaveLength(0);

    t.timer.advanceTime(GRACE_MS);
    await settle();
    t.timer.advanceTime(GRACE_MS);
    await settle();

    expect(outcome.settled()).toBe(true);
    expect(queued()).toBe(false);
    expect(t.refusals).toHaveLength(1);
    expect(String((t.refusals[0] as Error).message)).toContain(`held by unkillable process ${PID}`);
  });

  it("returns to an aborted caller at once while cleanup finishes in the background holding the lease", async () => {
    const t = setup();
    const controller = new AbortController();
    const reason = new Error("request cancelled");
    t.devices.waitForDeviceReady = async () => await new Promise<BootedDevice>(() => {});
    const outcome = track(t.boot(undefined, controller.signal));
    await settle();

    controller.abort(reason);
    await settle();

    // No timer has advanced: the caller is not held for the 2 s termination wait.
    expect(outcome.settled()).toBe(true);
    expect(outcome.error()).toBe(reason);
    expect(reason.message).toBe("request cancelled");
    expect(t.emulator.signals).toEqual(["SIGTERM"]);
    const nextGranted = t.nextRequestForAvd();
    await settle();
    expect(nextGranted()).toBe(false);

    // The daemon keeps finishing the cleanup, still holding the lease.
    t.timer.advanceTime(GRACE_MS);
    await settle();
    expect(t.emulator.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(nextGranted()).toBe(false);
    t.emulator.exit();
    await settle();
    expect(nextGranted()).toBe(true);
  });

  it("keeps a late-abandoned cleanup's survivor holding the lease and reports it", async () => {
    const t = setup();
    const controller = new AbortController();
    t.devices.waitForDeviceReady = async () => await new Promise<BootedDevice>(() => {});
    const outcome = track(t.boot(undefined, controller.signal));
    await settle();
    controller.abort(new Error("request cancelled"));
    await settle();
    expect(outcome.settled()).toBe(true);

    t.timer.advanceTime(GRACE_MS);
    await settle();
    t.timer.advanceTime(GRACE_MS);
    await settle();
    const next = t.nextRequestForAvd();
    await settle();

    expect(next()).toBe(false);
    expect(String((t.refusals[0] as Error).message)).toContain(`held by unkillable process ${PID}`);
    t.liveness.running = false;
    t.timer.advanceTime(SURVIVOR_RECHECK_MS);
    await settle();
    const afterGone = t.nextRequestForAvd();
    await settle();
    expect(afterGone()).toBe(true);
  });

  it("sends SIGKILL before a one-shot CLI boot returns when readiness times out at the deadline", async () => {
    const t = setup();
    t.devices.waitForDeviceReady = async () => await new Promise<BootedDevice>(() => {});
    // No long-lived owner, as in `--boot-device`: the process exits as soon as boot rejects.
    const outcome = track(
      t.boot(undefined, undefined, false, {
        cleanupMayOutliveRequest: false,
        timeoutMs: 10_000,
      }),
    );
    await settle();

    t.timer.advanceTime(10_000);
    await settle();
    // The budget is spent, but the caller is not released with only SIGTERM sent.
    expect(t.emulator.signals).toEqual(["SIGTERM"]);
    expect(outcome.settled()).toBe(false);

    t.timer.advanceTime(GRACE_MS);
    await settle();
    expect(t.emulator.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(outcome.settled()).toBe(false);

    t.timer.advanceTime(GRACE_MS);
    await settle();
    expect(outcome.settled()).toBe(true);
    expect(String((outcome.error() as Error).message)).toContain(
      "did not exit after SIGTERM and SIGKILL",
    );
  });

  it("keeps the daemon's abort race: a long-lived owner is released before SIGKILL", async () => {
    const t = setup();
    t.devices.waitForDeviceReady = async () => await new Promise<BootedDevice>(() => {});
    const outcome = track(t.boot(undefined, undefined, true, { timeoutMs: 10_000 }));
    await settle();

    t.timer.advanceTime(10_000);
    await settle();

    expect(t.emulator.signals).toEqual(["SIGTERM"]);
    expect(outcome.settled()).toBe(true);
  });

  it("still waits in full when an injected lease has no way to hold the survivor", async () => {
    const t = setup();
    const controller = new AbortController();
    t.devices.waitForDeviceReady = async () => await new Promise<BootedDevice>(() => {});
    const lease = await t.coordinator.reserve(
      { kind: "stable", platform: "android", stableId: image.name },
      { operation: "start", deadlineMs: 60_000 },
    );
    const outcome = track(t.boot(lease, controller.signal, false));
    await settle();

    controller.abort(new Error("request cancelled"));
    await settle();
    expect(outcome.settled()).toBe(false);

    t.emulator.exit();
    await settle();
    expect(outcome.settled()).toBe(true);
    lease.release();
  });

  it("never signals an adopted running emulator", async () => {
    const t = setup();
    const running: BootedDevice = {
      platform: "android",
      name: image.name,
      deviceId: "emulator-5554",
    };
    t.devices.setDeviceImages("android", [{ ...image, isRunning: true }]);
    t.devices.setBootedDevices("android", [running]);
    t.matcher.setBootedResult(running);
    t.devices.setWaitForDeviceReadyError(new Error("adopted emulator is wedged"));
    const outcome = track(t.boot());
    await settle();
    const nextGranted = t.nextRequestForAvd();
    await settle();

    expect(outcome.settled()).toBe(true);
    expect(String((outcome.error() as Error).message)).toContain("adopted emulator is wedged");
    expect(t.devices.wasMethodCalled("startDevice")).toBe(false);
    expect(t.emulator.signals).toEqual([]);
    expect(nextGranted()).toBe(true);
  });

  it("leaves a successful cold boot running and its lease released", async () => {
    const t = setup();
    const outcome = track(t.boot());
    await settle();

    expect(outcome.settled()).toBe(true);
    expect(outcome.error()).toBeUndefined();
    expect(t.emulator.signals).toEqual([]);
    expect(t.retained).toHaveLength(0);
    const nextGranted = t.nextRequestForAvd();
    await settle();
    expect(nextGranted()).toBe(true);
  });
});

// #10075: a launch cancelled after the emulator spawned (during its startup validation)
// hands the child to the owner on the cancellation error, so the same confirm-exit
// ordering applies to the launch phase as to a boot that fails after launch.
describe("DeviceBootService cancelled-launch termination (#10075)", () => {
  /** A fake `startDevice` that behaves like the real client: it rejects on abort, carrying the child. */
  function cancelLaunchOnAbort(t: ReturnType<typeof setup>, childAtCancel: ChildProcess | null) {
    t.devices.startDevice = async () => {
      const signal = getAbortSignal();
      await new Promise<void>((resolve) => {
        signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new EmulatorLaunchCancelledError(image.name, childAtCancel);
    };
  }

  it("terminates the child, escalates, and holds the lease until its exit is confirmed", async () => {
    const t = setup();
    const controller = new AbortController();
    cancelLaunchOnAbort(t, t.emulator.process);
    const outcome = track(t.boot(undefined, controller.signal));
    await settle();

    controller.abort(new Error("request cancelled"));
    await settle();

    // The caller is returned to at once; the cleanup carries on holding the lease.
    expect(outcome.settled()).toBe(true);
    expect(t.emulator.signals).toEqual(["SIGTERM"]);
    const nextGranted = t.nextRequestForAvd();
    await settle();
    expect(nextGranted()).toBe(false);

    t.timer.advanceTime(GRACE_MS);
    await settle();
    expect(t.emulator.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(nextGranted()).toBe(false);

    t.emulator.exit();
    await settle();
    expect(nextGranted()).toBe(true);
  });

  it("releases the lease as soon as a SIGTERM-only exit is confirmed", async () => {
    const t = setup();
    const controller = new AbortController();
    cancelLaunchOnAbort(t, t.emulator.process);
    track(t.boot(undefined, controller.signal));
    await settle();
    controller.abort(new Error("request cancelled"));
    await settle();
    const nextGranted = t.nextRequestForAvd();
    await settle();
    expect(nextGranted()).toBe(false);

    t.emulator.exit();
    await settle();

    expect(t.emulator.signals).toEqual(["SIGTERM"]);
    expect(nextGranted()).toBe(true);
  });

  it("keeps the lease and reports the pid for an emulator that never exits", async () => {
    const t = setup();
    const controller = new AbortController();
    cancelLaunchOnAbort(t, t.emulator.process);
    track(t.boot(undefined, controller.signal));
    await settle();
    controller.abort(new Error("request cancelled"));
    await settle();

    t.timer.advanceTime(GRACE_MS);
    await settle();
    t.timer.advanceTime(GRACE_MS);
    await settle();
    const next = t.nextRequestForAvd();
    await settle();

    expect(t.emulator.signals).toEqual(["SIGTERM", "SIGKILL"]);
    expect(next()).toBe(false);
    expect(String((t.refusals[0] as Error).message)).toContain(`held by unkillable process ${PID}`);

    t.liveness.running = false;
    t.timer.advanceTime(SURVIVOR_RECHECK_MS);
    await settle();
    const afterGone = t.nextRequestForAvd();
    await settle();
    expect(afterGone()).toBe(true);
  });

  it("hands a survivor to an injected lease's owner instead of releasing it", async () => {
    const t = setup();
    const controller = new AbortController();
    const lease = await t.coordinator.reserve(
      { kind: "stable", platform: "android", stableId: image.name },
      { operation: "start", deadlineMs: 60_000 },
    );
    cancelLaunchOnAbort(t, t.emulator.process);
    track(t.boot(lease, controller.signal));
    await settle();
    controller.abort(new Error("request cancelled"));
    await settle();

    t.timer.advanceTime(GRACE_MS);
    await settle();
    t.timer.advanceTime(GRACE_MS);
    await settle();

    expect(t.retained.length).toBeGreaterThan(0);
  });

  it("sends no signal when the launch was cancelled before anything spawned", async () => {
    const t = setup();
    const controller = new AbortController();
    cancelLaunchOnAbort(t, null);
    track(t.boot(undefined, controller.signal));
    await settle();
    controller.abort(new Error("request cancelled"));
    await settle();

    expect(t.emulator.signals).toEqual([]);
    const nextGranted = t.nextRequestForAvd();
    await settle();
    expect(nextGranted()).toBe(true);
  });
});
