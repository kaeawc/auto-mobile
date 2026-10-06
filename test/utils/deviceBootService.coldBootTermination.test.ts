import { EventEmitter } from "node:events";
import type { ChildProcess } from "node:child_process";
import { describe, expect, it } from "bun:test";
import { DeviceBootService } from "../../src/devices/deviceBootService";
import {
  InMemoryVirtualDeviceLifecycleCoordinator,
  type VirtualDeviceLifecycleLease,
} from "../../src/devices/virtualDeviceLifecycleCoordinator";
import type { BootedDevice, DeviceInfo } from "../../src/models";
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
const PID = 4242;

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
  devices.setDeviceImages("android", [image]);
  matcher.setImageResult(image);
  devices.setMockChildProcess(image.name, emulator.process);
  const boot = (lifecycleLease?: VirtualDeviceLifecycleLease, signal?: AbortSignal) =>
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
      retainLeaseUntil: (settlement) => retained.push(settlement),
    }).boot({ platform: "android", signal });
  // A second request for the same AVD: granted only once the first lease is released.
  const nextRequestForAvd = () => {
    let granted = false;
    void coordinator
      .reserve(
        { kind: "stable", platform: "android", stableId: image.name },
        { operation: "start", deadlineMs: 60_000 },
      )
      .then(() => {
        granted = true;
      });
    return () => granted;
  };
  return { devices, matcher, timer, coordinator, emulator, retained, boot, nextRequestForAvd };
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
    const nextGranted = t.nextRequestForAvd();

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
    // The AVD is not handed to a retry as if it were free.
    expect(nextGranted()).toBe(false);
    expect(t.retained).toHaveLength(1);

    // The survivor finally dies: only now is the lease released.
    t.emulator.exit();
    await settle();
    expect(nextGranted()).toBe(true);
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

  it("keeps the boot's own error when the process exit cannot be observed", async () => {
    const t = setup();
    t.devices.setWaitForDeviceReadyError(new Error("boot wedged"));
    t.emulator.process.once = () => {
      throw new Error("exit listener registration failed");
    };
    const outcome = track(t.boot());
    await settle();

    expect(outcome.settled()).toBe(true);
    expect(String((outcome.error() as Error).message)).toContain("boot wedged");
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
