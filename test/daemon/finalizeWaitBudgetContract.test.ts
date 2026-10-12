import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { DEVICE_CLEANUP_WAIT_BUDGET_MS } from "../../src/daemon/daemonMcpProxy";
import {
  DEVICE_CLEANUP_IN_PROGRESS_CODE,
  DEVICE_SHUTTING_DOWN_CODE,
  DeviceCleanupInProgressError,
  DeviceOwnedByOtherDaemonError,
  DeviceShuttingDownError,
  type RetryableDeviceAcquisitionError,
} from "../../src/daemon/deviceAcquisitionRefusals";
import {
  SESSION_RELEASE_PERSIST_TIMEOUT_MS,
  SESSION_RELEASE_TEARDOWN_CAP_MS,
} from "../../src/daemon/sessionManager";
import { readDeviceCleanupInProgressRefusal } from "../../src/server/deviceSessionResult";
import {
  createOwnerlessRecordingAcquisitionCleanup,
  defaultRecordingSessionCleanupDeps,
  registerRecordingSessionCleanup,
} from "../../src/server/recordingSessionCleanup";
import { shapeToolCallError } from "../../src/server/shapeToolCallError";
import { createDeviceSettingDefaultsAcquisitionReset } from "../../src/features/utility/DeviceSettingDefaults";
import { NetworkState } from "../../src/server/NetworkState";
import { createOwnerlessNetworkStateAcquisitionCleanup } from "../../src/server/networkStateSessionCleanup";
import { FakeTimer } from "../fakes/FakeTimer";

/**
 * The finalize wait budget every client shares (#11360). The JUnit runner and XCTestRunner pin
 * their own constants to the same `finalizeWait` entry (RefusalWireContractTest,
 * RefusalWireContractTests); this suite pins the MCP proxy and the daemon's advertised hints.
 */
const HINTS_FILE = fileURLToPath(
  new URL("../fixtures/refusal-wire-hints/hints.json", import.meta.url),
);

function finalizeWait(): { codes: string[]; waitBudgetMs: number } {
  const table: unknown = JSON.parse(readFileSync(HINTS_FILE, "utf8"));
  if (!table || typeof table !== "object" || !("finalizeWait" in table)) {
    throw new Error(`${HINTS_FILE} has no finalizeWait entry`);
  }
  const entry = table.finalizeWait;
  if (
    !entry ||
    typeof entry !== "object" ||
    !("codes" in entry) ||
    !Array.isArray(entry.codes) ||
    !("waitBudgetMs" in entry) ||
    typeof entry.waitBudgetMs !== "number"
  ) {
    throw new Error(`${HINTS_FILE} finalizeWait entry is malformed`);
  }
  return { codes: entry.codes.map(String), waitBudgetMs: entry.waitBudgetMs };
}

const shaped = (error: RetryableDeviceAcquisitionError) =>
  shapeToolCallError(error, { toolName: "startDevice", source: "MCP" });

/** The cap the recording cleanup registers for a device, with the production per-platform cap. */
function registeredRecordingCapMs(deviceId: string): number | undefined {
  const caps: Array<number | undefined> = [];
  const unbound: Array<(sessionId: string, deviceId: string) => void> = [];
  registerRecordingSessionCleanup(
    {
      onSessionRelease: () => {},
      onSessionDeviceUnbound: (callback) => {
        unbound.push(callback);
      },
      registerPendingDeviceCleanup: (_deviceId, _cleanup, capMs) => {
        caps.push(capMs);
      },
    },
    {
      hasRecordingsToStop: () => true,
      stopSegmentedRecordings: async () => {},
      listActiveVideoRecordings: async () => [],
      stopVideoRecording: async () => {},
      isDeviceGestureRecordingOwnedBy: () => false,
      ownedDeviceGestureRecordingId: () => undefined,
      stopDeviceGestureRecording: async () => {},
      activeRecordingIdsForOwner: () => [],
      timer: new FakeTimer(),
      finalizeCapMs: defaultRecordingSessionCleanupDeps.finalizeCapMs,
      markVideoRecordingIncomplete: async () => {},
    },
  );
  unbound.forEach((callback) => callback("session-a", deviceId));
  return caps[0];
}

describe("finalize wait budget shared with the runners (#11360)", () => {
  test("the MCP proxy's cleanup wait budget is the shared waitBudgetMs", () => {
    expect(DEVICE_CLEANUP_WAIT_BUDGET_MS).toBe(finalizeWait().waitBudgetMs);
  });

  test("the proxy waits out exactly the shared finalize codes", () => {
    expect(finalizeWait().codes.toSorted()).toEqual(
      [DEVICE_CLEANUP_IN_PROGRESS_CODE, DEVICE_SHUTTING_DOWN_CODE].toSorted(),
    );
    expect(
      readDeviceCleanupInProgressRefusal(
        shaped(new DeviceCleanupInProgressError("emulator-5554", 120_000)),
      ),
    ).toEqual({ retryAfterMs: 120_000 });
    expect(
      readDeviceCleanupInProgressRefusal(shaped(new DeviceShuttingDownError("emulator-5554"))),
    ).toBeDefined();
    expect(
      readDeviceCleanupInProgressRefusal(
        shaped(new DeviceOwnedByOtherDaemonError("emulator-5554", 4242)),
      ),
    ).toBeUndefined();
  });

  test("the daemon's bounded cleanups never advertise more than the shared waitBudgetMs", () => {
    const { waitBudgetMs } = finalizeWait();
    const advertised = [
      registeredRecordingCapMs("emulator-5554"),
      registeredRecordingCapMs("2300914A-231E-4874-8F8A-40C3D2F1E24B"),
      SESSION_RELEASE_TEARDOWN_CAP_MS + SESSION_RELEASE_PERSIST_TIMEOUT_MS,
    ];
    // Both platforms' finalize cap plus the incomplete-mark grace, then the release phases.
    expect(advertised).toEqual([125_000, 125_000, 20_000]);
    expect(Math.max(...advertised.map((capMs) => capMs ?? Infinity))).toBeLessThanOrEqual(
      waitBudgetMs,
    );
  });

  test("the three acquisition factories register caps within the shared waitBudgetMs", async () => {
    const timer = new FakeTimer();
    const caps: Array<number | undefined> = [];
    const cleanups: Promise<unknown>[] = [];
    const manager = {
      getSessionForDevice: () => "holder",
      registerAcquisitionDeviceCleanup: (
        _deviceId: string,
        cleanup: Promise<unknown>,
        capMs?: number,
      ) => {
        caps.push(capMs);
        cleanups.push(cleanup);
      },
    };
    createOwnerlessRecordingAcquisitionCleanup(manager, {
      timer,
      adoptVideoRecordings: async () => {},
      adoptSegmentedRecordings: () => {},
      adoptDeviceGestureRecording: () => false,
    })("device", "holder");
    const state = new NetworkState({ timer, notifier: { notifyResourceUpdated: () => {} } });
    state.startSimulation("device", "timeout", 30, null);
    createOwnerlessNetworkStateAcquisitionCleanup(manager, {
      timer,
      state: () => state,
      pusher: { push: async () => {} },
    })("device");
    createDeviceSettingDefaultsAcquisitionReset(
      manager,
      {
        resetOnAcquisition: async () => {},
      },
      timer,
    )("device", "holder");
    await Promise.all(cleanups);
    expect(caps).toEqual([5_000, 10_000, 15_000]);
    expect(Math.max(...caps.map((cap) => cap ?? Infinity))).toBeLessThanOrEqual(
      finalizeWait().waitBudgetMs,
    );
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
});
