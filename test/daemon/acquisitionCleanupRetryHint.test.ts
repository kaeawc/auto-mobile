import { afterEach, describe, expect, spyOn, test, mock } from "bun:test";
import { DeviceCleanupInProgressError } from "../../src/models/deviceAcquisitionRefusals";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  createOwnerlessRecordingAcquisitionCleanup,
  registerRecordingSessionCleanup,
  defaultRecordingSessionCleanupDeps,
  type RecordingAcquisitionDeps,
  type RecordingSessionCleanupDeps,
} from "../../src/daemon/recordingSessionCleanup";
import { NetworkState } from "../../src/utils/NetworkState";
import { createOwnerlessNetworkStateAcquisitionCleanup } from "../../src/daemon/networkStateSessionCleanup";
import { createDeviceSettingDefaultsAcquisitionReset } from "../../src/features/utility/DeviceSettingDefaults";
import { drainUntil } from "../helpers/fakeTimerStepping";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

afterEach(() => mock.restore());

// The hint contract of `device_cleanup_in_progress`.
//
// #11360 (owner decision 2026-10-10): the refusal's `retryAfterMs` is the finalize time still
// remaining, and both runners use it as a bound on the TOTAL wait:
// `max(30 s, min(waited + retryAfterMs, 150 s))` (`deviceOwnedBudgetMs` in
// AutoMobilePlanExecutor.kt, `effectiveBudgetMs` in AutoMobilePlanExecutor+DaemonRefusal.swift).
//
// #11665 replaces acquisition-time stops (#10961) with adoption by the holder, then a capped
// finalize at release. Preserve #11616's intent: the next acquirer's hint must carry the real
// finalize bound, never the 1 s default. Acquisition cleanup has its own cap and advertises only its remaining time.

const DEVICE = { deviceId: "emulator-5554", name: "Pixel A", platform: "android" as const };
const FINALIZE_CAP_MS = 120_000;
const RUNNER_DEFAULT_BUDGET_MS = 30_000;
const RUNNER_FINALIZE_WAIT_CAP_MS = 150_000;

/** The runners' total-wait rule for the finalize codes (Kotlin and Swift agree). */
function runnerBudgetMs(waitedMs: number, retryAfterMs: number): number {
  return Math.max(
    RUNNER_DEFAULT_BUDGET_MS,
    Math.min(waitedMs + retryAfterMs, RUNNER_FINALIZE_WAIT_CAP_MS),
  );
}

/** One recording per owner on the device whose stop never returns (a wedged capture backend). */
class WedgedRecordings implements RecordingSessionCleanupDeps, RecordingAcquisitionDeps {
  teardownRetryBackoff = defaultRecordingSessionCleanupDeps.teardownRetryBackoff;
  teardownRetryBudgetMs = defaultRecordingSessionCleanupDeps.teardownRetryBudgetMs;
  markDeviceNeedsRecorderRecovery =
    defaultRecordingSessionCleanupDeps.markDeviceNeedsRecorderRecovery;
  readonly active = new Map<string, string | undefined>();
  adoptionPersistence: Promise<void> | undefined;

  constructor(readonly timer: FakeTimer) {}

  hasRecordingsToStop(): boolean {
    return this.active.size > 0;
  }
  async abandonRecordingsOnReplacedDevice(): Promise<void> {}
  async stopSegmentedRecordings(): Promise<void> {}
  async listActiveVideoRecordings() {
    return [...this.active].map(([recordingId, ownerSessionUuid]) => ({
      recordingId,
      ownerSessionUuid,
    }));
  }
  async stopVideoRecording(): Promise<void> {
    await new Promise<void>(() => {});
  }
  isDeviceGestureRecordingOwnedBy(): boolean {
    return false;
  }
  ownedDeviceGestureRecordingId(): string | undefined {
    return undefined;
  }
  async stopDeviceGestureRecording(): Promise<void> {}
  adoptVideoRecordings(_deviceId: string, sessionId: string): Promise<void> | undefined {
    let adopted = false;
    for (const [recordingId, owner] of this.active) {
      if (owner === undefined) {
        this.active.set(recordingId, sessionId);
        adopted = true;
      }
    }
    return adopted ? this.adoptionPersistence : undefined;
  }
  adoptSegmentedRecordings(): void {}
  adoptDeviceGestureRecording(): boolean {
    return false;
  }
  activeRecordingIdsForOwner(sessionId: string | undefined): string[] {
    return [...this.active].filter(([, owner]) => owner === sessionId).map(([id]) => id);
  }
  retainedCaptureIdsForOwner(sessionId: string | undefined): string[] {
    return this.activeRecordingIdsForOwner(sessionId);
  }
  finalizeCapMs(): number {
    return FINALIZE_CAP_MS;
  }
  async markVideoRecordingIncomplete(recordingId: string): Promise<void> {
    this.active.delete(recordingId);
  }
}

describe("device_cleanup_in_progress retryAfterMs for a capped recording finalize", () => {
  let timer: FakeTimer;
  let manager: SessionManager;
  let pool: DevicePool;
  let recordings: WedgedRecordings;
  let warn: ReturnType<typeof spyOn>;

  async function arrangeHarness(): Promise<void> {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
      barrier: () => new FakeDbWriteBarrier(),
    });
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices("android", [DEVICE]);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "daemon-test", { timer, deviceManager: utils }),
    );
    await pool.initializeWithDevices([DEVICE]);
    recordings = new WedgedRecordings(timer);
  }

  afterEach(() => {
    warn.mockRestore();
    manager.stopCleanupTimer();
    timer.reset();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  /** The next acquirer's bind of the device, as the refusal it gets. */
  async function refusedBind(): Promise<DeviceCleanupInProgressError> {
    const refusal = await pool
      .bindOrReuseDeviceSession({
        sessionId: "next-owner",
        deviceId: DEVICE.deviceId,
        platform: "android",
      })
      .then(
        () => undefined,
        (error: unknown) => error,
      );
    expect(refusal).toBeInstanceOf(DeviceCleanupInProgressError);
    return refusal as DeviceCleanupInProgressError;
  }

  async function releaseHolder(): Promise<void> {
    await manager.releaseSession("holder");
    await pool.releaseDevice(DEVICE.deviceId, "holder");
  }

  test("control: the release-time finalize advertises its remaining cap (#11360)", async () => {
    await arrangeHarness();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    registerRecordingSessionCleanup(manager, recordings);
    await pool.bindOrReuseDeviceSession({
      sessionId: "holder",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
    recordings.active.set("rec-holder", "holder");

    await releaseHolder();

    const refusal = await refusedBind();
    expect(refusal.retryAfterMs).toBeGreaterThan(FINALIZE_CAP_MS);
    expect(runnerBudgetMs(0, refusal.retryAfterMs)).toBeGreaterThanOrEqual(FINALIZE_CAP_MS);
  });

  test("an adopted owner-less recording advertises the full finalize cap at release", async () => {
    await arrangeHarness();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    registerRecordingSessionCleanup(manager, recordings);
    const adoptOwnerlessRecordings = createOwnerlessRecordingAcquisitionCleanup(
      manager,
      recordings,
    );
    // A sessionless recording is capturing the device when a session acquires it.
    recordings.active.set("rec-ownerless", undefined);
    await pool.bindOrReuseDeviceSession({
      sessionId: "holder",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
    adoptOwnerlessRecordings(DEVICE.deviceId, "holder");
    expect(recordings.active.has("rec-ownerless")).toBe(true);
    expect(recordings.active.get("rec-ownerless")).toBe("holder");
    // The holder's own reuse is not refused (#11041).
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(false);

    // Adoption keeps capturing; the finalize starts only when the holder releases 5 s later.
    timer.advanceTime(5_000);
    await releaseHolder();
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(true);

    const refusal = await refusedBind();
    expect(refusal.retryAfterMs).toBeGreaterThanOrEqual(FINALIZE_CAP_MS);
    expect(runnerBudgetMs(0, refusal.retryAfterMs)).toBeGreaterThanOrEqual(FINALIZE_CAP_MS);
  });

  test("the adopted recording's hint subtracts only time spent finalizing after release", async () => {
    await arrangeHarness();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    registerRecordingSessionCleanup(manager, recordings);
    const adoptOwnerlessRecordings = createOwnerlessRecordingAcquisitionCleanup(
      manager,
      recordings,
    );
    recordings.active.set("rec-ownerless", undefined);
    await pool.bindOrReuseDeviceSession({
      sessionId: "holder",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
    adoptOwnerlessRecordings(DEVICE.deviceId, "holder");
    timer.advanceTime(5_000);
    await releaseHolder();

    timer.advanceTime(60_000);

    // 120 s cap + 5 s incomplete-mark grace, less 60 s since release; acquisition time is excluded.
    expect((await refusedBind()).retryAfterMs).toBe(65_000);
  });

  test("an acquisition cleanup with no cap of its own keeps the default polling hint", async () => {
    await arrangeHarness();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    await pool.bindOrReuseDeviceSession({
      sessionId: "holder",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
    manager.registerAcquisitionDeviceCleanup(DEVICE.deviceId, new Promise<void>(() => {}));
    await releaseHolder();

    expect((await refusedBind()).retryAfterMs).toBe(1_000);
  });

  test("an acquisition hook for a session other than the holder adopts nothing", async () => {
    await arrangeHarness();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    const adoptOwnerlessRecordings = createOwnerlessRecordingAcquisitionCleanup(
      manager,
      recordings,
    );
    recordings.active.set("rec-ownerless", undefined);
    recordings.adoptionPersistence = new Promise<void>(() => {});
    await pool.bindOrReuseDeviceSession({
      sessionId: "holder",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
    const registerCleanup = spyOn(manager, "registerAcquisitionDeviceCleanup");
    try {
      adoptOwnerlessRecordings(DEVICE.deviceId, "other-session");

      expect(recordings.active.has("rec-ownerless")).toBe(true);
      expect(recordings.active.get("rec-ownerless")).toBeUndefined();
      expect(registerCleanup).not.toHaveBeenCalled();
      expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(false);
    } finally {
      registerCleanup.mockRestore();
    }
  });

  test("wedged adoption persistence advertises its remaining cap and releases quarantine", async () => {
    await arrangeHarness();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    registerRecordingSessionCleanup(manager, recordings);
    const adoptOwnerlessRecordings = createOwnerlessRecordingAcquisitionCleanup(
      manager,
      recordings,
    );
    recordings.active.set("rec-ownerless", undefined);
    recordings.adoptionPersistence = new Promise<void>(() => {});
    await pool.bindOrReuseDeviceSession({
      sessionId: "holder",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
    adoptOwnerlessRecordings(DEVICE.deviceId, "holder");
    expect(recordings.active.get("rec-ownerless")).toBe("holder");
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(false);
    await pool.bindOrReuseDeviceSession({
      sessionId: "holder",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
    recordings.active.delete("rec-ownerless");

    await releaseHolder();

    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(true);
    expect((await refusedBind()).retryAfterMs).toBe(5_000);
    timer.advanceTime(2_000);
    expect((await refusedBind()).retryAfterMs).toBe(3_000);
    timer.advanceTime(2_999);
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(true);
    expect(warn).not.toHaveBeenCalled();
    timer.advanceTime(1);
    await drainUntil(() => !manager.hasDeviceCleanupInProgress(DEVICE.deviceId), {
      description: "acquisition quarantine cleared",
    });
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("persist adopted recording ownership");
    await pool.bindOrReuseDeviceSession({
      sessionId: "next-owner",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
  });

  test("wedged acquisition network push advertises its cap and releases quarantine", async () => {
    await arrangeHarness();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    const state = new NetworkState({ timer, notifier: { notifyResourceUpdated: () => {} } });
    state.startSimulation(DEVICE.deviceId, "timeout", 30, { limit: null });
    const cleanup = createOwnerlessNetworkStateAcquisitionCleanup(manager, {
      timer,
      state: () => state,
      pusher: { push: () => new Promise<void>(() => {}) },
    });
    await pool.bindOrReuseDeviceSession({
      sessionId: "holder",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
    cleanup(DEVICE.deviceId);
    expect(state.getSimulation(DEVICE.deviceId)).toBeNull();
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(false);
    await pool.bindOrReuseDeviceSession({
      sessionId: "holder",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
    await releaseHolder();
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(true);
    expect((await refusedBind()).retryAfterMs).toBe(10_000);
    timer.advanceTime(10_000);
    await drainUntil(() => !manager.hasDeviceCleanupInProgress(DEVICE.deviceId), {
      description: "acquisition quarantine cleared",
    });
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(false);
    // The push's own deadline race and the bounded acquisition cleanup both report the cap.
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining("exceeded 10000ms"));
    await pool.bindOrReuseDeviceSession({
      sessionId: "next-owner",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
  });

  test("wedged acquisition settings reset advertises its cap and releases quarantine", async () => {
    await arrangeHarness();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    const cleanup = createDeviceSettingDefaultsAcquisitionReset(
      manager,
      { resetOnAcquisition: () => new Promise<void>(() => {}) },
      timer,
    );
    await pool.bindOrReuseDeviceSession({
      sessionId: "holder",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
    cleanup(DEVICE.deviceId, "holder");
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(false);
    await pool.bindOrReuseDeviceSession({
      sessionId: "holder",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
    await releaseHolder();
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(true);
    expect((await refusedBind()).retryAfterMs).toBe(15_000);
    timer.advanceTime(15_000);
    await drainUntil(() => !manager.hasDeviceCleanupInProgress(DEVICE.deviceId), {
      description: "acquisition quarantine cleared",
    });
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(false);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0][0]).toContain("reset device setting defaults");
    await pool.bindOrReuseDeviceSession({
      sessionId: "next-owner",
      deviceId: DEVICE.deviceId,
      platform: "android",
    });
  });
});
