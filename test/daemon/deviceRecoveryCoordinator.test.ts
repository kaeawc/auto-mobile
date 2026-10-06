import { describe, expect, test } from "bun:test";
import {
  DeviceRecoveryCoordinator,
  type DeviceRecoveryPoolPort,
} from "../../src/daemon/deviceRecoveryCoordinator";
import { AndroidRecoveryRecordLedger } from "../../src/daemon/androidRecoveryRecordLedger";
import { FakeTimer } from "../fakes/FakeTimer";
import type { PooledDevice } from "../../src/daemon/devicePool";
import type { BootedDeviceDiscovery } from "../../src/devices/deviceUtils";

const flushMicrotasks = async (): Promise<void> => {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
};

function harness() {
  const timer = new FakeTimer();
  const ledger = new AndroidRecoveryRecordLedger(
    { getDevice: () => null, getSession: () => null, clearAdbResetReservation: () => {} },
    timer,
  );
  const records = ledger.recoveringSessionLosses;
  const quarantined = new Set<string>();
  const settlements = new Map<string, Promise<void>>();
  let refreshGeneration = 0;
  const port: DeviceRecoveryPoolPort = {
    getRefreshGeneration: () => refreshGeneration,
    getPooledDevice: () => undefined,
    getSessionForDevice: () => undefined,
    waitForReleasingSession: () => undefined,
    getAndroidSessionPreservingRecoveryTarget: () => undefined,
    getSessionPreservingRecoveryTarget: () => undefined,
    isIOSSimulatorContinuityDevice: (device): device is PooledDevice & { platform: "ios" } =>
      device.platform === "ios",
    performSessionPreservingRecovery: async () => "not-attempted",
    finishEmulatorLossIncident: async () => {},
    recoverSessionBoundAndroidDeviceAfterAdbServerReset: async () => false,
    releaseAdbServerResetCohortReservations: async () => {},
    getEmulatorLossIncident: async () => undefined,
    completeJoinedEmulatorLossRecovery: async () => {},
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
    setRefreshGeneration: (generation: number) => {
      refreshGeneration = generation;
    },
  };
}

const image = { name: "Pixel", platform: "android" as const, isRunning: false };

describe("DeviceRecoveryCoordinator", () => {
  for (const platform of ["android", "ios"] as const) {
    for (const sessionId of [undefined, "live-session"]) {
      test(`${platform} missing recovery target with ${sessionId ?? "no session"} leaves settlement to its caller`, async () => {
        const { coordinator, port } = harness();
        let finished = false;
        port.getSessionForDevice = () => sessionId;
        port.finishEmulatorLossIncident = async () => {
          finished = true;
        };
        const result =
          platform === "android"
            ? await coordinator.recoverSessionBoundAndroidDeviceAfterLoss("device", "incident")
            : await coordinator.recoverSessionBoundIOSSimulatorAfterLoss("device", "incident");
        expect(result).toBe("not-attempted");
        expect(finished).toBe(false);
      });
    }
  }

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

  describe("an unconfirmed sessionless recovery reservation", () => {
    const owner = Symbol("owner");
    const discovery = (
      devices: { deviceId: string; name: string }[],
      succeeded = true,
    ): BootedDeviceDiscovery => ({
      devices: devices.map((device) => ({ ...device, platform: "android" as const })),
      succeededPlatforms: new Set(succeeded ? ["android" as const] : []),
    });
    const retained = (lateShutdown?: Promise<unknown>, generation = 3) => {
      const h = harness();
      h.setRefreshGeneration(generation);
      h.coordinator.setRecoveringAndroidImage("Pixel", image);
      h.coordinator.finishAndroidRecoveryAttempt("Pixel", new Set(), true, owner, lateShutdown);
      return h;
    };

    test("keeps the image, wakes waiters, and is reported to startup", async () => {
      const { coordinator } = retained();
      expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(true);
      expect(coordinator.findUnconfirmedRecoveringAndroidImage(["Other", "Pixel"])).toBe("Pixel");
      expect(coordinator.findUnconfirmedRecoveringAndroidImage(["Other"])).toBeUndefined();
    });

    test("a waiter blocked on the attempt is released when it ends unconfirmed", async () => {
      const h = harness();
      h.coordinator.setRecoveringAndroidImage("Pixel", image);
      const waiting = h.coordinator.waitForRecoveringAndroidImages(["Pixel"]);
      h.coordinator.finishAndroidRecoveryAttempt("Pixel", new Set(), true, owner);
      await waiting;
      expect(h.coordinator.findUnconfirmedRecoveringAndroidImage(["Pixel"])).toBe("Pixel");
    });

    test("a later newer fresh observation without the AVD lifts it", () => {
      const { coordinator } = retained();
      coordinator.liftUnconfirmedRecoveringAndroidImages(discovery([]), 4);
      expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(false);
      expect(coordinator.findUnconfirmedRecoveringAndroidImage(["Pixel"])).toBeUndefined();
    });

    test("a later newer fresh observation with the AVD running lifts it", () => {
      const { coordinator } = retained();
      coordinator.liftUnconfirmedRecoveringAndroidImages(
        discovery([{ deviceId: "emulator-5554", name: "Pixel" }]),
        4,
      );
      expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(false);
    });

    test.each([
      ["a refresh that started before the attempt ended", discovery([]), 3],
      ["failed Android discovery", discovery([], false), 4],
      [
        "an unresolved emulator identity",
        discovery([{ deviceId: "emulator-5556", name: "Unknown (emulator-5556)" }]),
        4,
      ],
      [
        "two emulators reporting the AVD name",
        discovery([
          { deviceId: "emulator-5554", name: "Pixel" },
          { deviceId: "emulator-5556", name: "Pixel" },
        ]),
        4,
      ],
    ])("%s keeps it", (_label, observation, generation) => {
      const { coordinator } = retained();
      coordinator.liftUnconfirmedRecoveringAndroidImages(observation, generation);
      expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(true);
    });

    test("waits for the late kill to settle, then needs an observation newer than that", async () => {
      const lateKill = Promise.withResolvers<void>();
      const { coordinator, setRefreshGeneration } = retained(lateKill.promise);
      coordinator.liftUnconfirmedRecoveringAndroidImages(discovery([]), 4);
      expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(true);
      setRefreshGeneration(5);
      lateKill.resolve();
      await flushMicrotasks();
      // Observed after the attempt but before the kill settled: not authoritative.
      coordinator.liftUnconfirmedRecoveringAndroidImages(discovery([]), 5);
      expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(true);
      coordinator.liftUnconfirmedRecoveringAndroidImages(discovery([]), 6);
      expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(false);
    });

    test("a rejected late kill still counts as settled", async () => {
      const lateKill = Promise.withResolvers<void>();
      const { coordinator } = retained(lateKill.promise);
      lateKill.reject(new Error("kill failed"));
      await flushMicrotasks();
      coordinator.liftUnconfirmedRecoveringAndroidImages(discovery([]), 4);
      expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(false);
    });

    test("an image owned by a recovery record is never marked unconfirmed", () => {
      const h = harness();
      h.coordinator.setRecoveringAndroidImage("Pixel", image);
      h.records.set("session", {
        sessionId: "session",
        generation: 1,
        deviceId: "emulator-5554",
        avdName: "Pixel",
        deferredShutdowns: 0,
        state: "pending",
        reservations: new Set(["image"]),
      });
      h.coordinator.finishAndroidRecoveryAttempt("Pixel", new Set(), true, owner);
      expect(h.coordinator.findUnconfirmedRecoveringAndroidImage(["Pixel"])).toBeUndefined();
      h.coordinator.liftUnconfirmedRecoveringAndroidImages(discovery([]), 4);
      expect(h.coordinator.recoveringAndroidImages.has("Pixel")).toBe(true);
    });

    test("a new attempt takes the reservation back", () => {
      const { coordinator } = retained();
      coordinator.setRecoveringAndroidImage("Pixel", image);
      expect(coordinator.findUnconfirmedRecoveringAndroidImage(["Pixel"])).toBeUndefined();
      coordinator.finishAndroidRecoveryAttempt("Pixel", new Set(), false, owner);
      expect(coordinator.recoveringAndroidImages.has("Pixel")).toBe(false);
    });
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

  test("joins an in-flight loss and settles the joining incident from the primary outcome", async () => {
    const { coordinator, port } = harness();
    const gate = Promise.withResolvers<"recovered">();
    const completed: string[] = [];
    const settled: string[] = [];
    port.getSessionForDevice = () => "session";
    port.getEmulatorLossIncident = async () =>
      ({
        recovery: { outcome: "recovered" },
        session: { state: "awaiting-device" },
      }) as Awaited<ReturnType<typeof port.getEmulatorLossIncident>>;
    port.completeJoinedEmulatorLossRecovery = async (id, outcome, state) => {
      completed.push(`${id}:${outcome}:${state}`);
    };
    port.settleEmulatorLossIncident = (id) => {
      if (id) {
        settled.push(id);
      }
    };
    coordinator.registerSessionPreservingRecovery("session", {
      promise: gate.promise,
      incidentId: "primary",
    });
    const joined = coordinator.recoverSessionBoundAndroidDeviceAfterLoss("emulator-5554", "joiner");
    gate.resolve("recovered");
    expect(await joined).toBe("recovered");
    expect(completed).toEqual(["joiner:recovered:awaiting-device"]);
    expect(settled).toEqual(["joiner"]);
  });

  test("preparation keeps its quarantine until the matching token finishes", () => {
    const { coordinator, port, records, quarantined } = harness();
    port.getAndroidSessionPreservingRecoveryTarget = () =>
      ({ device: { id: "emulator-5554" }, session: { sessionId: "session" } }) as NonNullable<
        ReturnType<typeof port.getAndroidSessionPreservingRecoveryTarget>
      >;
    const preparation = coordinator.prepareSessionPreservingRecovery("emulator-5554");
    expect(preparation).toBeDefined();
    expect(quarantined.has("session")).toBe(true);
    coordinator.finishSessionPreservingRecoveryPreparation({
      sessionId: "session",
      token: Symbol("stale"),
    });
    expect(records.has("session")).toBe(true);
    coordinator.finishSessionPreservingRecoveryPreparation(preparation);
    expect(records.has("session")).toBe(false);
    expect(quarantined.has("session")).toBe(false);
  });

  test("deferred recovery checks the live record after an awaited earlier entry", async () => {
    const { coordinator, port, records, timer } = harness();
    const device = { id: "emulator-5554" } as PooledDevice;
    const gate = Promise.withResolvers<void>();
    const recovered: string[] = [];
    port.recoverSessionBoundAndroidDeviceAfterAdbServerReset = async (id) => {
      recovered.push(id);
      await gate.promise;
      return false;
    };
    const first = coordinator.startAndroidRecoveryRecord(
      "first",
      { deviceId: "first", expectedDevice: device },
      ["loss"],
    );
    const second = coordinator.startAndroidRecoveryRecord(
      "second",
      { deviceId: "second", expectedDevice: device },
      ["loss"],
    );
    first.state = "deferred";
    second.state = "deferred";
    first.deferredUntil = timer.now();
    second.deferredUntil = timer.now();
    const retry = coordinator.retryDueDeferredSessionRecoveries();
    records.delete("second");
    gate.resolve();
    await retry;
    expect(recovered).toEqual(["first"]);
  });
});
