import { describe, expect, test } from "bun:test";
import type { ChildProcess } from "child_process";
import type { BootedDevice } from "../../../src/models";
import { BootCapacityExhaustedError } from "../../../src/models/BootCapacityExhaustedError";
import {
  AndroidRebootCoordinator,
  type AndroidRebootCoordinatorPoolPort,
} from "../../../src/daemon/androidRebootCoordinator";
import { AndroidRecoveryRecordLedger } from "../../../src/daemon/androidRecoveryRecordLedger";
import { DeviceCriteriaMatcher } from "../../../src/daemon/DeviceCriteriaMatcher";
import type { DeviceRecoveryPolicy, PooledDevice } from "../../../src/daemon/devicePool";
import { BoundedAndroidDeviceReboot } from "../../../src/devices/androidDeviceReboot";
import type { IdentityEvidence } from "../../../src/devices/deviceIdentityEvidence";
import type { PlatformDeviceManager } from "../../../src/devices/deviceUtils";
import { FakeTimer } from "../../fakes/FakeTimer";

// Hunt 2026-10-11, device-restart recovery, cell 6 (boot capacity across a restart in place).
//
// A device lost under a live session is relaunched by `AndroidRebootCoordinator` through the
// device manager's `startDevice`, which is where the boot admission gate answers
// `capacity_exhausted` at the limit (deviceUtils.ts, `admitColdBoot`). That refusal is typed
// retryable and is made before any emulator process exists.
//
// `BoundedAndroidDeviceReboot.run` treats it as a crashed launch: it charges the AVD's crash-loop
// budget (2 attempts per 15 minutes by default) and retries after its fixed 1 s backoff, ignoring
// the refusal's `retryAfterMs`. Two refusals one second apart therefore exhaust the budget, the
// incident is recorded as two failed relaunches / `exhausted`, and recovery of that AVD is disabled
// for 15 minutes although the emulator was never touched. A recovery cancelled before touching the
// emulator is already refunded for exactly this reason (#7545).

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

function capacityRefusal(): BootCapacityExhaustedError {
  return new BootCapacityExhaustedError(
    { retryAfterMs: 5_000, limit: 2, booted: 2, platform: "android" },
    "Android boot capacity exhausted: 2 of 2 devices are booted",
  );
}

class RecoveryPort implements AndroidRebootCoordinatorPoolPort {
  readonly attempts: string[] = [];
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

function setup() {
  const timer = new FakeTimer();
  timer.setCurrentTime(0);
  timer.enableAutoAdvance();
  /** How many boots the host refuses for capacity before a slot frees. */
  const host = { refusalsLeft: 0, launches: 0, refusals: 0 };
  const manager = {
    startDevice: async (): Promise<ChildProcess | null> => {
      if (host.refusalsLeft > 0) {
        host.refusalsLeft--;
        host.refusals++;
        throw capacityRefusal();
      }
      host.launches++;
      return null;
    },
    waitForDeviceReady: async () => relaunched,
  } as PlatformDeviceManager;
  const port = new RecoveryPort(manager, timer);
  const coordinator = new AndroidRebootCoordinator(
    port,
    new AndroidRecoveryRecordLedger(
      { getDevice: () => null, getSession: () => null, clearAdbResetReservation: () => {} },
      timer,
    ),
    new DeviceCriteriaMatcher(),
    // The production budget: DEFAULT_DEVICE_RECOVERY_MAX_ATTEMPTS relaunches per 15 minutes.
    new BoundedAndroidDeviceReboot(timer, 2),
  );
  const recover = () =>
    coordinator.rebootDisconnectedAndroidDeviceCoordinated(
      lost,
      "incident",
      { preserveSessionId: "session-s" },
      new AbortController().signal,
      () => {},
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
      // Both tries were refused one second apart, although the refusal says to retry in 5 s.
      refusals: 2,
      // No emulator was ever launched for the first loss, so no crash was observed for this AVD.
      recovered: true,
      launches: 1,
      bound: ["session-s"],
    });
  });
});
