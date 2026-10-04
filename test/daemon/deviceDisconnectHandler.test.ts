import { describe, expect, test } from "bun:test";
import {
  DeviceDisconnectHandler,
  INCARNATION_ANY,
  type DeviceDisconnectPoolPort,
} from "../../src/daemon/deviceDisconnectHandler";
import type { PooledDevice } from "../../src/daemon/devicePool";
import type { BootedDeviceDiscovery } from "../../src/devices/deviceUtils";
import type { DeviceInfo } from "../../src/models";
import { UnconfirmedRecoveryShutdownError } from "../../src/daemon/androidRebootCoordinator";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { drainUntil } from "../helpers/fakeTimerStepping";
import { EmulatorLossIncidentLedger } from "../../src/daemon/emulatorLossIncidentLedger";
import {
  InMemoryEmulatorLossIncidentStore,
  type EmulatorRecoveryOutcome,
} from "../../src/daemon/emulatorLossIncident";
import type { RetryExecutor } from "../../src/utils/retry/RetryExecutor";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";

function pooledDevice(incarnation = 1): PooledDevice {
  return {
    id: "emulator-5554",
    name: "Pixel",
    platform: "android",
    avdName: "Pixel",
    androidImage: { name: "Pixel", platform: "android", isRunning: true },
    sessionId: null,
    status: "idle",
    lastUsedAt: 0,
    assignmentCount: 0,
    errorCount: 0,
    incarnation,
  };
}

function discovery(names: string[], succeeded = true): BootedDeviceDiscovery {
  return {
    devices: names.map((name) => ({ deviceId: "emulator-5554", name, platform: "android" })),
    succeededPlatforms: new Set(succeeded ? ["android" as const] : []),
  };
}

function harness() {
  const timer = new FakeTimer();
  const device = pooledDevice();
  const devices = new Map([[device.id, device]]);
  const markers = new Map<string, number>();
  const events: string[] = [];
  const outcomes = new Map<string | undefined, EmulatorRecoveryOutcome>();
  const settlements: (string | undefined)[] = [];
  const fallbacks: ("exhausted" | "not-attempted")[] = [];
  let reserved = false;
  let recoveryEnabled = false;
  let rebootResult = false;
  let manager = { getBootedDevicesDetailed: async () => discovery([]) };
  const port: DeviceDisconnectPoolPort = {
    getPooledDevice: (id) => devices.get(id),
    getIntentionalShutdownMarker: (id) => markers.get(id),
    deleteIntentionalShutdownMarker: (id) => {
      events.push("marker-deleted");
      markers.delete(id);
    },
    isReservedForShutdown: () => reserved,
    removeDevice: async (_id, awaitCacheCleanup, expected) => {
      events.push(`remove:${awaitCacheCleanup}`);
      expect(devices.get(device.id)).toBe(expected);
      devices.delete(device.id);
    },
    finishEmulatorLossIncident: async (id, outcome) => {
      events.push(`finish:${outcome}`);
      outcomes.set(id, outcome);
      settlements.push(id);
    },
    recordEmulatorLossIncident: async () => {
      events.push("record");
      return "recorded";
    },
    shouldRebootDisconnectedAndroidDevice: () => recoveryEnabled,
    rebootDisconnectedAndroidDevice: async () => {
      events.push("reboot");
      return rebootResult;
    },
    settleEmulatorLossIncident: (id) => {
      events.push("settle");
      settlements.push(id);
    },
    suppressAutoStartForDevice: () => events.push("suppress"),
    completeEmulatorLossRecovery: async (id, outcome) => {
      events.push(`complete:${outcome}`);
      outcomes.set(id, outcome);
    },
    refreshEmulatorLossRecoverySettlement: async (id, fallback) => {
      fallbacks.push(fallback);
      const outcome = outcomes.get(id) ?? fallback;
      events.push(`complete:${outcome}`);
      outcomes.set(id, outcome);
    },
    getRecoveryPolicy: () => ({ onLoss: recoveryEnabled, maxAttempts: 2 }),
    isAndroidEmulatorActiveRelaunchEligible: (
      candidate,
    ): candidate is PooledDevice & { avdName: string; androidImage: DeviceInfo } =>
      candidate.platform === "android" &&
      typeof candidate.avdName === "string" &&
      candidate.androidImage !== undefined,
    getDeviceManager: () => manager,
    androidRediscoveryMatches: (candidate, id, avdName) =>
      candidate.deviceId === id && candidate.name === avdName,
  };
  return {
    timer,
    device,
    devices,
    markers,
    events,
    outcomes,
    settlements,
    fallbacks,
    port,
    handler: new DeviceDisconnectHandler(port),
    reserve: () => {
      reserved = true;
    },
    enableRecovery: () => {
      recoveryEnabled = true;
    },
    setRebootResult: (result: boolean) => {
      rebootResult = result;
    },
    setManager: (next: typeof manager) => {
      manager = next;
    },
  };
}

describe("DeviceDisconnectHandler", () => {
  test("finishes a missing or mismatched incarnation without cleanup", async () => {
    const h = harness();
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident", pooledDevice(2));
    h.devices.delete(h.device.id);
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident");
    expect(h.events).toEqual(["finish:not-attempted", "finish:not-attempted"]);
  });

  test("defers a reserved or assigned device", async () => {
    const h = harness();
    h.reserve();
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident");
    expect(h.events).toEqual(["finish:not-attempted"]);
    const assigned = harness();
    assigned.device.sessionId = "session";
    await assigned.handler.removeDisconnectedDevice(assigned.device.id, false, "incident");
    expect(assigned.events).toEqual(["finish:not-attempted"]);
    expect(assigned.devices.get(assigned.device.id)).toBe(assigned.device);
  });

  test("consumes an intentional marker and removes only its captured incarnation", async () => {
    const h = harness();
    h.markers.set(h.device.id, INCARNATION_ANY);
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident");
    expect(h.events).toEqual(["marker-deleted", "remove:true", "finish:not-attempted"]);
    expect(h.markers.size).toBe(0);
    expect(h.outcomes.get("incident")).toBe("not-attempted");
    expect(h.settlements).toEqual(["incident"]);
  });

  test.each([undefined, "not-attempted", "exhausted", "recovered"] as const)(
    "settles throwing intentional shutdown removal with persisted outcome %s",
    async (persistedOutcome) => {
      const h = harness();
      h.markers.set(h.device.id, h.device.incarnation);
      if (persistedOutcome) {
        h.outcomes.set("incident", persistedOutcome);
      }
      const failure = new Error("cache cleanup failed");
      h.port.removeDevice = async () => {
        h.events.push("remove:true");
        throw failure;
      };
      await expect(h.handler.removeDisconnectedDevice(h.device.id, false, "incident")).rejects.toBe(
        failure,
      );
      const outcome = persistedOutcome ?? "not-attempted";
      expect(h.fallbacks).toEqual(["not-attempted"]);
      expect(h.events).toEqual(["marker-deleted", "remove:true", `complete:${outcome}`, "settle"]);
      expect(h.outcomes.get("incident")).toBe(outcome);
      expect(h.settlements).toEqual(["incident"]);
    },
  );

  test.each([
    "getIntentionalShutdownMarker",
    "deleteIntentionalShutdownMarker",
    "getRecoveryPolicy",
  ] as const)(
    "keeps exhausted fallback when %s throws before intentional removal",
    async (method) => {
      const h = harness();
      h.markers.set(h.device.id, h.device.incarnation);
      const failure = new Error("intentional shutdown check failed");
      h.port[method] = () => {
        throw failure;
      };
      await expect(h.handler.removeDisconnectedDevice(h.device.id, true, "incident")).rejects.toBe(
        failure,
      );
      expect(h.fallbacks).toEqual(["exhausted"]);
      expect(h.outcomes.get("incident")).toBe("exhausted");
      expect(h.settlements).toEqual(["incident"]);
      expect(h.events).not.toContain("remove:true");
    },
  );

  test("retains an assigned intentional shutdown marker until release", async () => {
    const h = harness();
    h.device.sessionId = "session";
    h.markers.set(h.device.id, h.device.incarnation);
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident");
    expect(h.markers.get(h.device.id)).toBe(h.device.incarnation);
    expect(h.events).toEqual(["finish:not-attempted"]);
  });

  test("drops a prior incarnation's marker and cleans up the replacement", async () => {
    const h = harness();
    const replacement = pooledDevice(2);
    h.devices.set(h.device.id, replacement);
    h.markers.set(h.device.id, h.device.incarnation);
    await h.handler.removeDisconnectedDevice(h.device.id, false);
    expect(h.events).toEqual([
      "marker-deleted",
      "record",
      "reboot",
      "suppress",
      "remove:true",
      "complete:not-attempted",
      "settle",
    ]);
  });

  test("keeps a rediscovered device and reports unknown when discovery fails", async () => {
    const h = harness();
    h.enableRecovery();
    h.setManager({ getBootedDevicesDetailed: async () => discovery(["Pixel"]) });
    expect(await h.handler.isCurrentDisconnectedDevice(h.device)).toBe("recovered");
    await h.handler.removeDisconnectedDevice(h.device.id, true, "incident");
    expect(h.events).toEqual(["finish:not-attempted"]);
    h.setManager({ getBootedDevicesDetailed: async () => discovery([], false) });
    expect(await h.handler.isCurrentDisconnectedDevice(h.device)).toBe("unknown");
    expect(h.devices.get(h.device.id)).toBe(h.device);
  });

  test("retains an intentional marker when the stale signal still sees its AVD", async () => {
    const h = harness();
    h.enableRecovery();
    h.markers.set(h.device.id, h.device.incarnation);
    h.setManager({ getBootedDevicesDetailed: async () => discovery(["Pixel"]) });
    await h.handler.removeDisconnectedDevice(h.device.id, true, "incident");
    expect(h.markers.get(h.device.id)).toBe(h.device.incarnation);
    expect(h.events).toEqual(["finish:not-attempted"]);
    expect(await h.handler.isCurrentDisconnectedDevice(h.device)).toBe("recovered");
  });

  test("settles without removing a replacement installed during reboot", async () => {
    const h = harness();
    const replacement = pooledDevice(2);
    h.port.rebootDisconnectedAndroidDevice = async () => {
      h.events.push("reboot");
      h.devices.set(h.device.id, replacement);
      return false;
    };
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident");
    expect(h.events).toEqual(["reboot", "complete:not-attempted", "settle"]);
    expect(h.devices.get(h.device.id)).toBe(replacement);
  });

  test("does not complete an already-attempted failed recovery", async () => {
    const h = harness();
    h.enableRecovery();
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident");
    expect(h.events).toEqual(["reboot", "suppress", "remove:true", "settle"]);
    expect(await h.handler.isCurrentDisconnectedDevice(h.device)).toBe("recovered");
  });

  test("settles an unconfirmed plain reboot shutdown and rethrows the same error", async () => {
    const h = harness();
    h.enableRecovery();
    const failure = new UnconfirmedRecoveryShutdownError("Pixel", new Error("still running"));
    h.port.rebootDisconnectedAndroidDevice = async () => {
      h.events.push("reboot");
      throw failure;
    };
    await expect(h.handler.removeDisconnectedDevice(h.device.id, false)).rejects.toBe(failure);
    expect(h.events).toEqual(["record", "reboot", "complete:exhausted", "settle"]);
  });

  test("settles failed removal without recovery and rethrows the same error", async () => {
    const h = harness();
    const failure = new Error("cache cleanup failed");
    h.port.removeDevice = async () => {
      h.events.push("remove:true");
      throw failure;
    };
    await expect(h.handler.removeDisconnectedDevice(h.device.id, false)).rejects.toBe(failure);
    expect(h.fallbacks).toEqual(["exhausted"]);
    expect(h.events).toEqual([
      "record",
      "reboot",
      "suppress",
      "remove:true",
      "complete:exhausted",
      "settle",
    ]);
  });

  test("settles a throwing recovery decision without attempting recovery", async () => {
    const h = harness();
    const failure = new Error("policy unavailable");
    h.port.shouldRebootDisconnectedAndroidDevice = () => {
      throw failure;
    };
    await expect(h.handler.removeDisconnectedDevice(h.device.id, false)).rejects.toBe(failure);
    expect(h.events).toEqual(["record", "complete:exhausted", "settle"]);
  });

  test("settles throwing suppression without attempting recovery", async () => {
    const h = harness();
    const failure = new Error("suppression failed");
    h.port.suppressAutoStartForDevice = () => {
      throw failure;
    };
    await expect(h.handler.removeDisconnectedDevice(h.device.id, false)).rejects.toBe(failure);
    expect(h.events).toEqual(["record", "reboot", "complete:exhausted", "settle"]);
  });

  test("persists exhausted when reboot declines without an outcome and removal throws", async () => {
    const h = harness();
    h.enableRecovery();
    const failure = new Error("remove failed");
    h.port.removeDevice = async () => {
      h.events.push("remove:true");
      throw failure;
    };
    await expect(h.handler.removeDisconnectedDevice(h.device.id, false, "incident")).rejects.toBe(
      failure,
    );
    expect(h.events).toEqual(["reboot", "suppress", "remove:true", "complete:exhausted", "settle"]);
    expect(h.outcomes.get("incident")).toBe("exhausted");
    expect(h.settlements).toEqual(["incident"]);
  });

  test("does not overwrite coordinator exhausted outcome when later removal throws", async () => {
    const h = harness();
    h.enableRecovery();
    const failure = new Error("remove failed");
    h.port.rebootDisconnectedAndroidDevice = async () => {
      await h.port.completeEmulatorLossRecovery("incident", "exhausted");
      return false;
    };
    h.port.removeDevice = async () => {
      h.events.push("remove:true");
      throw failure;
    };
    await expect(h.handler.removeDisconnectedDevice(h.device.id, false, "incident")).rejects.toBe(
      failure,
    );
    expect(h.events).toEqual([
      "complete:exhausted",
      "suppress",
      "remove:true",
      "complete:exhausted",
      "settle",
    ]);
    expect(h.outcomes.get("incident")).toBe("exhausted");
    expect(h.settlements).toEqual(["incident"]);
  });

  test("coordinator recovered outcome returns true and never reaches removal", async () => {
    const h = harness();
    h.enableRecovery();
    h.port.rebootDisconnectedAndroidDevice = async () => {
      h.outcomes.set("incident", "recovered");
      h.events.push("complete:recovered");
      return true;
    };
    h.port.removeDevice = async () => {
      throw new Error("recovered device must not be removed");
    };
    await h.handler.removeDisconnectedDevice(h.device.id, false, "incident");
    expect(h.events).toEqual(["complete:recovered", "settle"]);
    expect(h.outcomes.get("incident")).toBe("recovered");
    expect(h.settlements).toEqual(["incident"]);
  });

  test.each([false, true])(
    "preserves the original cleanup error if incident refresh fails, intentional=%s",
    async (intentional) => {
      const h = harness();
      if (intentional) {
        h.markers.set(h.device.id, h.device.incarnation);
      }
      const failure = new Error("cache cleanup failed");
      h.port.removeDevice = async () => {
        throw failure;
      };
      h.port.refreshEmulatorLossRecoverySettlement = async () => {
        h.events.push("refresh-failed");
        throw new Error("incident store unavailable");
      };
      await expect(h.handler.removeDisconnectedDevice(h.device.id, false, "incident")).rejects.toBe(
        failure,
      );
      expect(h.events).toEqual(
        intentional
          ? ["marker-deleted", "refresh-failed", "settle"]
          : ["reboot", "suppress", "refresh-failed", "settle"],
      );
      expect(h.settlements).toEqual(["incident"]);
    },
  );

  test.each([false, true])(
    "real ledger settles throwing intentional removal with session present=%s",
    async (sessionPresent) => {
      const h = harness();
      const store = new InMemoryEmulatorLossIncidentStore(h.timer, new FakeIdGenerator());
      const sessions = new SessionManager(h.timer, new FakeDeviceSessionPersistence());
      const session = await sessions.createSession("session", h.device.id, "android");
      const retryExecutor: RetryExecutor = {
        execute: async () => {
          throw new Error("unused");
        },
        executeOrThrow: async (operation) => operation(1),
      };
      let capturingSession = true;
      const ledger = new EmulatorLossIncidentLedger(
        {
          getDevice: () => h.device,
          getRecoveryPolicy: h.port.getRecoveryPolicy,
          getSessionForDevice: () => session.sessionId,
          getSession: () => (capturingSession || sessionPresent ? session : null),
          getProcessOutputTail: () => undefined,
        },
        store,
        h.timer,
        retryExecutor,
      );
      h.port.refreshEmulatorLossRecoverySettlement = (id, outcome) =>
        ledger.refreshEmulatorLossRecoverySettlement(id, outcome);
      h.port.settleEmulatorLossIncident = (id) => ledger.settleEmulatorLossIncident(id);
      const id = (await ledger.recordEmulatorLossIncident(h.device.id, "device-discovery-miss"))!;
      expect((await store.get(id))?.session?.sessionUuid).toBe(session.sessionId);
      capturingSession = false;
      // The incident can retain a session snapshot even though the pooled device is unassigned.
      const waiting = ledger.waitForEmulatorLossIncident(id);
      let resolved = false;
      void waiting.then(() => {
        resolved = true;
      });
      expect(h.timer.getPendingTimeouts()).toEqual([120_000]);
      h.markers.set(h.device.id, h.device.incarnation);
      const failure = new Error("cache cleanup failed");
      h.port.removeDevice = async () => {
        throw failure;
      };
      await expect(h.handler.removeDisconnectedDevice(h.device.id, false, id)).rejects.toBe(
        failure,
      );
      await drainUntil(() => resolved, {
        description: "incident wait after throwing cleanup",
        maxTurns: 100,
      });
      const incident = await waiting;
      expect(incident?.recovery.outcome).toBe("not-attempted");
      expect(incident?.session?.state).toBe(sessionPresent ? "active" : "released");
      expect(ledger.emulatorLossRecoveryResolvers.size).toBe(0);
      expect(ledger.emulatorLossRecoverySettlements.size).toBe(0);
      expect(h.timer.getPendingTimeoutCount()).toBe(0);
      expect(h.timer.now()).toBe(0);
    },
  );

  test("rechecks incarnation after a delayed stale-signal discovery", async () => {
    const h = harness();
    h.timer.enableAutoAdvance();
    h.enableRecovery();
    h.setManager({
      getBootedDevicesDetailed: async () => {
        await h.timer.sleep(5);
        return discovery([]);
      },
    });
    const cleanup = h.handler.removeDisconnectedDevice(h.device.id, true, "incident");
    const replacement = pooledDevice(2);
    h.devices.set(h.device.id, replacement);
    await cleanup;
    expect(h.devices.get(h.device.id)).toBe(replacement);
    expect(h.events).toEqual(["finish:not-attempted"]);
  });

  test("preserves record, reboot, completion, removal, and settlement order", async () => {
    const h = harness();
    await h.handler.removeDisconnectedDevice(h.device.id, false);
    expect(h.events).toEqual([
      "record",
      "reboot",
      "suppress",
      "remove:true",
      "complete:not-attempted",
      "settle",
    ]);
    const recovered = harness();
    recovered.enableRecovery();
    recovered.setRebootResult(true);
    await recovered.handler.removeDisconnectedDevice(recovered.device.id, false, "incident");
    expect(recovered.events).toEqual(["reboot", "settle"]);
    expect(recovered.devices.get(recovered.device.id)).toBe(recovered.device);
  });
});
