import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { DeviceCleanupInProgressError } from "../../src/daemon/deviceAcquisitionRefusals";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  createOwnerlessRecordingAcquisitionCleanup,
  registerRecordingSessionCleanup,
  type RecordingSessionCleanupDeps,
} from "../../src/server/recordingSessionCleanup";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeTimer } from "../fakes/FakeTimer";
import { createDevicePoolDependencies } from "../helpers/devicePoolDependencies";

// The hint contract of `device_cleanup_in_progress`.
//
// #11360 (owner decision 2026-10-10): the refusal's `retryAfterMs` is the finalize time still
// remaining, and both runners use it as a bound on the TOTAL wait:
// `max(30 s, min(waited + retryAfterMs, 150 s))` (`deviceOwnedBudgetMs` in
// AutoMobilePlanExecutor.kt, `effectiveBudgetMs` in AutoMobilePlanExecutor+DaemonRefusal.swift).
//
// The same capped finalize runs at release (#11360) and as ACQUISITION cleanup (#10961, #11041):
// a session that acquires a device stops the owner-less recordings on it, through the same
// `stopOwnedRecordingsWithinCap` (120 s cap). #11616: the acquisition registration carried no
// cap, so once that holder released, the next acquirer's refusal carried the 1 s default and a
// runner budgeted 30 s while the daemon was still legitimately finalizing for up to two minutes.

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
class WedgedRecordings implements RecordingSessionCleanupDeps {
  readonly active = new Map<string, string | undefined>();

  constructor(readonly timer: FakeTimer) {}

  hasRecordingsToStop(): boolean {
    return this.active.size > 0;
  }
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
  isTestRecordingOwnedBy(): boolean {
    return false;
  }
  async stopTestRecording(): Promise<void> {}
  activeRecordingIdsForOwner(sessionId: string | undefined): string[] {
    return [...this.active].filter(([, owner]) => owner === sessionId).map(([id]) => id);
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

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000_000);
    manager = new SessionManager(
      timer,
      new FakeDeviceSessionPersistence(),
      () => new FakeDbWriteBarrier(),
    );
    const utils = new FakeDeviceUtils();
    utils.setBootedDevices("android", [DEVICE]);
    pool = new DevicePool(
      createDevicePoolDependencies(manager, "daemon-test", { timer, deviceManager: utils }),
    );
    await pool.initializeWithDevices([DEVICE]);
    recordings = new WedgedRecordings(timer);
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(() => {
    warn.mockRestore();
    manager.stopCleanupTimer();
  });

  /** The next acquirer's bind of the device, as the refusal it gets. */
  async function refusedBind(): Promise<DeviceCleanupInProgressError> {
    const refusal = await pool
      .bindOrReuseDeviceSession("next-owner", DEVICE.deviceId, "android")
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
    registerRecordingSessionCleanup(manager, recordings);
    await pool.bindOrReuseDeviceSession("holder", DEVICE.deviceId, "android");
    recordings.active.set("rec-holder", "holder");

    await releaseHolder();

    const refusal = await refusedBind();
    expect(refusal.retryAfterMs).toBeGreaterThan(FINALIZE_CAP_MS);
    expect(runnerBudgetMs(0, refusal.retryAfterMs)).toBeGreaterThanOrEqual(FINALIZE_CAP_MS);
  });

  test("the owner-less finalize started on acquisition advertises its remaining cap too", async () => {
    const stopOwnerlessRecordings = createOwnerlessRecordingAcquisitionCleanup(manager, recordings);
    // A sessionless recording is capturing the device when a session acquires it.
    recordings.active.set("rec-ownerless", undefined);
    await pool.bindOrReuseDeviceSession("holder", DEVICE.deviceId, "android");
    stopOwnerlessRecordings(DEVICE.deviceId);
    // The holder's own reuse is not refused (#11041).
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(false);

    // The holder is done 5 s later; the wedged stop is 115 s short of its cap.
    timer.advanceTime(5_000);
    await releaseHolder();
    expect(manager.hasDeviceCleanupInProgress(DEVICE.deviceId)).toBe(true);

    const refusal = await refusedBind();
    // The daemon finalizes for up to 115 s more, so the hint must say so; a runner that trusts
    // it must not give up before the cap.
    const remainingCapMs = FINALIZE_CAP_MS - 5_000;
    expect(refusal.retryAfterMs).toBeGreaterThanOrEqual(remainingCapMs);
    expect(runnerBudgetMs(0, refusal.retryAfterMs)).toBeGreaterThanOrEqual(remainingCapMs);
  });

  test("the acquisition hint is the time remaining: cap plus grace, less the time already run", async () => {
    const stopOwnerlessRecordings = createOwnerlessRecordingAcquisitionCleanup(manager, recordings);
    recordings.active.set("rec-ownerless", undefined);
    await pool.bindOrReuseDeviceSession("holder", DEVICE.deviceId, "android");
    stopOwnerlessRecordings(DEVICE.deviceId);
    timer.advanceTime(5_000);
    await releaseHolder();

    timer.advanceTime(60_000);

    // 120 s cap + 5 s incomplete-mark grace, 65 s in; never more than the finalize can still take.
    expect((await refusedBind()).retryAfterMs).toBe(60_000);
  });

  test("an acquisition cleanup with no cap of its own keeps the default polling hint", async () => {
    await pool.bindOrReuseDeviceSession("holder", DEVICE.deviceId, "android");
    manager.registerAcquisitionDeviceCleanup(DEVICE.deviceId, new Promise<void>(() => {}));
    await releaseHolder();

    expect((await refusedBind()).retryAfterMs).toBe(1_000);
  });
});
