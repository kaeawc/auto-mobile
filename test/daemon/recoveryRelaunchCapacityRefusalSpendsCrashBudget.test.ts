import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "child_process";
import type { BootedDevice } from "../../src/models";
import { BootCapacityExhaustedError } from "../../src/models/BootCapacityExhaustedError";
import {
  AndroidBootedDeviceDiscoveryIncompleteError,
  BootedDeviceDiscoveryIncompleteError,
} from "../../src/models/BootedDeviceDiscoveryIncompleteError";
import { DEFAULT_DEVICE_READY_TIMEOUT_MS } from "../../src/utils/deviceTimeouts";
import {
  AndroidRebootCoordinator,
  type AndroidRebootCoordinatorPoolPort,
} from "../../src/daemon/androidRebootCoordinator";
import { AndroidRecoveryRecordLedger } from "../../src/daemon/androidRecoveryRecordLedger";
import { DeviceCriteriaMatcher } from "../../src/daemon/DeviceCriteriaMatcher";
import type { DeviceRecoveryPolicy, PooledDevice } from "../../src/daemon/devicePool";
import { BoundedAndroidDeviceReboot } from "../../src/devices/androidDeviceReboot";
import type { IdentityEvidence } from "../../src/devices/deviceIdentityEvidence";
import type { PlatformDeviceManager } from "../../src/devices/deviceUtils";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeTimer } from "../fakes/FakeTimer";

// Admission refusals precede any launch: retry the hint within the recovery window without
// consuming the AVD's crash-loop budget or recording failed launches (#11691, #7545).

const AVD = "Pixel";
const lost: PooledDevice = {
  id: "emulator-5554",
  name: AVD,
  platform: "android",
  avdName: AVD,
  androidImage: { name: AVD, platform: "android", isRunning: false, source: "local" },
  sessionId: null,
  status: "idle",
  lastUsedAt: 0,
  assignmentCount: 0,
  errorCount: 0,
  incarnation: 1,
};
const relaunched: BootedDevice = { deviceId: "emulator-5554", name: AVD, platform: "android" };

function capacityRefusal(retryAfterMs = 5_000): BootCapacityExhaustedError {
  return new BootCapacityExhaustedError(
    { retryAfterMs, limit: 2, booted: 2, platform: "android" },
    "Android boot capacity exhausted: 2 of 2 devices are booted",
  );
}

class RecoveryPort implements AndroidRebootCoordinatorPoolPort {
  readonly attempts: string[] = [];
  readonly attemptNumbers: number[] = [];
  readonly outcomes: string[] = [];
  readonly bound: Array<string | undefined> = [];

  constructor(
    private readonly manager: PlatformDeviceManager,
    private readonly timer: FakeTimer,
  ) {}

  getDeviceManager(): PlatformDeviceManager {
    return this.manager;
  }
  getTimer(): FakeTimer {
    return this.timer;
  }
  getRecoveryPolicy(): DeviceRecoveryPolicy {
    return { onLoss: true, maxAttempts: 2 };
  }
  async completeEmulatorLossRecovery(_incidentId: string | undefined, outcome: string) {
    this.outcomes.push(outcome);
  }
  async recordEmulatorLossRecoveryAttempt(
    _incidentId: string | undefined,
    attempt: { attempt: number; outcome: "failed" | "succeeded" },
  ) {
    this.attempts.push(attempt.outcome);
    this.attemptNumbers.push(attempt.attempt);
  }
  setRecoveringAndroidImage(): void {}
  addRecoveringAndroidDeviceId(): void {}
  setAndroidRecoveryHandoffOwner(): void {}
  clearAndroidRecoveryHandoffOwnerIfCurrent(): void {}
  finishAndroidRecoveryAttempt(): void {}
  async stopAndroidEmulatorForRecovery(): Promise<"stopped"> {
    return "stopped";
  }
  async rebindSameAvdReplacementSession(): Promise<boolean> {
    return true;
  }
  detachSessionForAndroidRecovery(): boolean {
    return true;
  }
  async removeDevice(): Promise<void> {}
  async addDevice(): Promise<void> {}
  identityEvidenceForBootedDevice(): IdentityEvidence {
    return {} as IdentityEvidence;
  }
  async bindRecoveredAndroidDeviceSession(
    _previousDeviceId: string,
    _avdName: string,
    preservedSessionId: string | undefined,
  ): Promise<void> {
    this.bound.push(preservedSessionId);
  }
  async stopEmulatorProcess(): Promise<void> {}
  consumeAndroidRecoveryCancellation(): boolean {
    return false;
  }
}

function setup(
  recoveryWindowMs = DEFAULT_DEVICE_READY_TIMEOUT_MS,
  refusal: Error = capacityRefusal(),
) {
  const timer = new FakeTimer();
  timer.setCurrentTime(0);
  timer.enableAutoAdvance();
  /** How many boots the host refuses for capacity before a slot frees. */
  const host = { refusalsLeft: 0, launches: 0, refusals: 0, refusedAt: [] as number[] };
  const manager = new FakeDeviceManager();
  manager.startDevice = async (): Promise<ChildProcess | null> => {
    if (host.refusalsLeft > 0) {
      host.refusalsLeft--;
      host.refusals++;
      host.refusedAt.push(timer.now());
      throw refusal;
    }
    host.launches++;
    return null;
  };
  manager.waitForDeviceReady = async () => relaunched;
  const port = new RecoveryPort(manager, timer);
  const coordinator = new AndroidRebootCoordinator(
    port,
    new AndroidRecoveryRecordLedger(
      { getDevice: () => null, getSession: () => null, clearAdbResetReservation: () => {} },
      timer,
    ),
    new DeviceCriteriaMatcher(),
    // The production budget: DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS relaunches per 15 minutes.
    new BoundedAndroidDeviceReboot(timer, 2, undefined, recoveryWindowMs),
  );
  const recover = () =>
    coordinator.rebootDisconnectedAndroidDeviceCoordinated(
      lost,
      "incident",
      { preserveSessionId: "session-s" },
      { signal: new AbortController().signal, retainLeaseUntil: () => {} },
    );
  return { timer, host, port, recover };
}

describe("a recovery relaunch refused for boot capacity", () => {
  test("control: a launch that crashes twice exhausts the AVD's crash-loop budget", async () => {
    const { host, port, recover, timer } = setup();
    const manager = port.getDeviceManager();
    manager.startDevice = async () => {
      host.launches++;
      throw new Error("emulator exited during boot");
    };

    expect(await recover()).toBe(false);
    expect(await recover()).toBe(false);
    expect({ launches: host.launches, attempts: port.attempts, at: timer.now() }).toEqual({
      launches: 2,
      attempts: ["failed", "failed"],
      at: 1_000,
    });
  });

  test("does not spend the crash-loop budget: the next loss of the AVD is still recovered", async () => {
    const { host, port, recover, timer } = setup();

    // The host is at its boot limit for as long as this recovery keeps asking.
    host.refusalsLeft = Number.POSITIVE_INFINITY;
    expect(await recover()).toBe(false);
    expect(timer.now()).toBe(DEFAULT_DEVICE_READY_TIMEOUT_MS);
    expect(port.attempts).toEqual([]);
    expect(host.launches).toBe(0);
    expect(port.outcomes).toEqual(["exhausted"]);
    expect(host.refusedAt).toEqual(Array.from({ length: 36 }, (_, i) => i * 5_000));
    const refusals = host.refusals;

    // A slot frees; the AVD is started again, and lost again well inside the 15 minute window.
    host.refusalsLeft = 0;
    timer.advanceTime(60_000);
    const recovered = await recover();

    expect({
      refusals,
      recovered,
      launches: host.launches,
      bound: port.bound,
    }).toEqual({
      refusals: 36,
      // No emulator was ever launched for the first loss, so no crash was observed for this AVD.
      recovered: true,
      launches: 1,
      bound: ["session-s"],
    });
    expect(port.attempts).toEqual(["succeeded"]);
    expect(port.attemptNumbers).toEqual([1]);
  });

  test("capacity frees mid-window: the first hinted retry launches and binds", async () => {
    const { host, port, recover, timer } = setup(12_000, capacityRefusal(7_000));
    host.refusalsLeft = 1;
    expect(await recover()).toBe(true);
    expect(host.refusedAt).toEqual([0]);
    expect(timer.getSleepHistory()).toEqual([7_000]);
    expect(timer.now()).toBe(7_000);
    expect(host.launches).toBe(1);
    expect(port.bound).toEqual(["session-s"]);
    expect(port.attempts).toEqual(["succeeded"]);
    expect(port.attemptNumbers).toEqual([1]);
  });

  test.each([
    new BootedDeviceDiscoveryIncompleteError("android", undefined),
    new AndroidBootedDeviceDiscoveryIncompleteError(undefined),
  ])("%s refunds discovery refusals and clips the last wait at the deadline", async (refusal) => {
    const { host, port, recover, timer } = setup(12_000, refusal);
    host.refusalsLeft = Number.POSITIVE_INFINITY;
    expect(await recover()).toBe(false);
    expect(host.refusedAt).toEqual([0, 5_000, 10_000]);
    expect(timer.getSleepHistory()).toEqual([5_000, 5_000, 2_000]);
    expect(timer.now()).toBe(12_000);
    expect(port.attempts).toEqual([]);
    expect(host.launches).toBe(0);
    host.refusalsLeft = 0;
    expect(await recover()).toBe(true);
    expect(port.attempts).toEqual(["succeeded"]);
    expect(port.attemptNumbers).toEqual([1]);
  });

  test("capacity refusals then one real crash charge one failed launch before success", async () => {
    const { host, port, recover, timer } = setup(12_000);
    host.refusalsLeft = 2;
    const startDevice = port.getDeviceManager().startDevice;
    port.getDeviceManager().startDevice = async (...args) => {
      const child = await startDevice(...args);
      if (host.launches === 1) {
        throw new Error("emulator exited during boot");
      }
      return child;
    };
    expect(await recover()).toBe(true);
    expect(host.refusedAt).toEqual([0, 5_000]);
    expect(timer.getSleepHistory()).toEqual([5_000, 5_000, 1_000]);
    expect(host.launches).toBe(2);
    expect(port.attempts).toEqual(["failed", "succeeded"]);
    expect(port.attemptNumbers).toEqual([1, 2]);
    expect(port.bound).toEqual(["session-s"]);
  });

  test("capacity retries also clip a hint longer than the remaining recovery window", async () => {
    const { host, port, recover, timer } = setup(7_000);
    host.refusalsLeft = Number.POSITIVE_INFINITY;
    expect(await recover()).toBe(false);
    expect(host.refusedAt).toEqual([0, 5_000]);
    expect(timer.getSleepHistory()).toEqual([5_000, 2_000]);
    expect(timer.now()).toBe(7_000);
    expect(port.attempts).toEqual([]);
  });

  test("the refusal window starts after the existing-budget backoff and preserves that budget", async () => {
    const { host, port, recover, timer } = setup(7_000);
    expect(await recover()).toBe(true);
    host.refusalsLeft = Number.POSITIVE_INFINITY;
    expect(await recover()).toBe(false);
    expect(host.refusedAt).toEqual([1_000, 6_000]);
    expect(timer.now()).toBe(8_000);
    expect(port.attempts).toEqual(["succeeded"]);
    host.refusalsLeft = 0;
    expect(await recover()).toBe(true);
    // Only the two genuine launches have spent the two-attempt budget.
    expect(await recover()).toBe(false);
    expect(host.launches).toBe(2);
    expect(port.attempts).toEqual(["succeeded", "succeeded"]);
  });
});
