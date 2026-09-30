import { describe, expect, test } from "bun:test";
import {
  DeviceRecoveryCoordinator,
  type DeviceRecoveryPoolPort,
} from "../../src/daemon/deviceRecoveryCoordinator";
import { AndroidRecoveryRecordLedger } from "../../src/daemon/androidRecoveryRecordLedger";
import { FakeTimer } from "../fakes/FakeTimer";

function harness() {
  const timer = new FakeTimer();
  const ledger = new AndroidRecoveryRecordLedger(
    { getDevice: () => null, getSession: () => null, clearAdbResetReservation: () => {} },
    timer,
  );
  const records = ledger.recoveringSessionLosses;
  const quarantined = new Set<string>();
  const settlements = new Map<string, Promise<void>>();
  const port: DeviceRecoveryPoolPort = {
    getRecoveringSessionLosses: () => records,
    getTimer: () => timer,
    getAndroidRecoveryRecordLedger: () => ledger,
    getAdbServerResetQuarantinedSessions: () => quarantined,
    getEmulatorLossRecoverySettlements: () => settlements,
    hasReleasedDeviceCapture: () => false,
    refreshEmulatorLossRecoverySettlement: async () => {},
    settleEmulatorLossIncident: () => {},
    completeEmulatorLossRecovery: async () => {},
    releaseDisconnectedRecoverySessionWithRetry: async (_sessionId, _deviceId, _reason, attempt) =>
      attempt(),
    releaseDevice: async () => {},
  };
  return {
    coordinator: new DeviceRecoveryCoordinator(port),
    port,
    records,
    ledger,
    quarantined,
    timer,
  };
}

const image = { name: "Pixel", platform: "android" as const, isRunning: false };

describe("DeviceRecoveryCoordinator", () => {
  test("record finalization clears image, quarantine, and the exact ledger generation", () => {
    const { coordinator, records, quarantined } = harness();
    coordinator.setRecoveringAndroidImage("Pixel", image);
    const first = coordinator.startAndroidRecoveryRecord(
      "session",
      { deviceId: "emulator-5554", avdName: "Pixel" },
      ["quarantine", "image"],
    );
    expect(quarantined.has("session")).toBe(true);
    const replacement = coordinator.startAndroidRecoveryRecord(
      "session",
      { deviceId: "emulator-5556", avdName: "Pixel" },
      ["quarantine", "image"],
      true,
    );
    expect(coordinator.finalizeRecoveryRecord("session", first)).toBe(false);
    expect(records.get("session")).toBe(replacement);
    expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(true);
    expect(coordinator.finalizeRecoveryRecord("session", replacement)).toBe(true);
    expect(quarantined.has("session")).toBe(false);
    expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(false);
  });

  test("terminal release publishes one retry flight before invoking the release", async () => {
    const { coordinator, ledger, port, records } = harness();
    const record = coordinator.startAndroidRecoveryRecord(
      "session",
      { deviceId: "emulator-5554" },
      ["failed-release", "quarantine"],
    );
    const gate = Promise.withResolvers<string | null>();
    let attempts = 0;
    port.releaseDisconnectedRecoverySessionWithRetry = async (
      _session,
      _device,
      _reason,
      attempt,
    ) => {
      attempts++;
      await attempt();
      ledger.markAndroidRecoveryRecordReleased("session");
    };
    const first = coordinator.releaseFailedRecoveryOnExpiry(
      "session",
      "cleanup-expired",
      () => gate.promise,
    );
    expect(coordinator.isSessionRecoveryInFlight("session")).toBe(true);
    expect(
      await coordinator.releaseFailedRecoveryOnExpiry(
        "session",
        "cleanup-expired",
        () => gate.promise,
      ),
    ).toBe(null);
    gate.resolve("emulator-5554");
    expect(await first).toBe("emulator-5554");
    expect(attempts).toBe(1);
    expect(records.has("session")).toBe(false);
    expect(record.state).toBe("finalized");
  });

  test("failed terminal release retains its fence until the FakeTimer retry deadline", async () => {
    const { coordinator, port, records, timer } = harness();
    const record = coordinator.startAndroidRecoveryRecord(
      "session",
      { deviceId: "emulator-5554" },
      ["failed-release", "quarantine"],
    );
    port.releaseDisconnectedRecoverySessionWithRetry = async () => {
      throw new Error("persistence failed");
    };
    await expect(
      coordinator.releaseFailedRecoveryOnExpiry("session", "lazy-expiry", async () => null),
    ).rejects.toThrow("persistence failed");
    expect(records.get("session")).toBe(record);
    expect(record.failedReleaseAttempts).toBe(1);
    expect(coordinator.isSessionRecoveryInFlight("session")).toBe(true);
    timer.advanceTime(5_000);
    expect(coordinator.isSessionRecoveryInFlight("session")).toBe(false);
  });

  test("image settlement releases a waiting startup and keeps the same promise on duplicate set", async () => {
    const { coordinator } = harness();
    coordinator.setRecoveringAndroidImage("Pixel", image);
    let settled = false;
    const waiting = coordinator.waitForRecoveringAndroidImages(["Pixel"]).then(() => {
      settled = true;
    });
    coordinator.setRecoveringAndroidImage("Pixel", image);
    await Promise.resolve();
    expect(settled).toBe(false);
    coordinator.clearRecoveringAndroidImage("Pixel");
    await waiting;
    expect(settled).toBe(true);
    expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(false);
  });

  test("finish drops only its owner and retains an image reserved by a live record", () => {
    const { coordinator, records } = harness();
    const own = Symbol("own");
    const other = Symbol("other");
    coordinator.setRecoveringAndroidImage("Pixel", image);
    coordinator.addRecoveringAndroidDeviceId("emulator-5554");
    coordinator.setAndroidRecoveryHandoffOwner("emulator-5554", own);
    coordinator.setAndroidRecoveryHandoffOwner("emulator-5556", other);
    records.set("session", {
      sessionId: "session",
      generation: 1,
      deviceId: "emulator-5554",
      avdName: "Pixel",
      deferredShutdowns: 0,
      state: "pending",
      reservations: new Set(["image"]),
    });
    coordinator.finishAndroidRecoveryAttempt("Pixel", new Set(["emulator-5554"]), false, own);
    expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(true);
    expect(coordinator.recoveringAndroidDeviceIds.has("emulator-5554")).toBe(false);
    expect(coordinator.isAndroidRecoveryHandoffReserved("emulator-5554")).toBe(false);
    expect(coordinator.isAndroidRecoveryHandoffReserved("emulator-5556")).toBe(true);
    expect(coordinator.isAndroidRecoveryHandoffReserved("emulator-5556", new Set([other]))).toBe(
      false,
    );
    records.clear();
    coordinator.finishAndroidRecoveryAttempt("Pixel", new Set(), false, other);
    expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(false);
  });

  test("aborted settlement wait preserves its rejection reason and removes its listener", async () => {
    const { coordinator } = harness();
    coordinator.setRecoveringAndroidImage("Pixel", image);
    const abort = new AbortController();
    const reason = new Error("cancelled");
    const waiting = coordinator.waitForRecoveringAndroidImages(["Pixel"], abort.signal);
    abort.abort(reason);
    await expect(waiting).rejects.toBe(reason);
    coordinator.clearRecoveringAndroidImage("Pixel");
  });

  test("an untracked image waits one FakeTimer retry and returns", async () => {
    const { coordinator, timer } = harness();
    coordinator.recoveringAndroidImages.set("Pixel", image);
    const waiting = coordinator.waitForRecoveringAndroidImages(["Pixel"]);
    expect(timer.getSleepHistory()).toEqual([250]);
    timer.advanceTime(250);
    await waiting;
  });
});
