import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { Daemon } from "../../src/daemon/daemon";
import { PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS } from "../../src/daemon/deviceDisconnectHandler";
import type { PooledDevice } from "../../src/daemon/devicePool";
import type { BootedDeviceDiscoveryOptions } from "../../src/devices/deviceUtils";
import {
  InMemoryEmulatorLossIncidentStore,
  type EmulatorLossDetectionPath,
} from "../../src/daemon/emulatorLossIncident";
import { executionTracker } from "../../src/server/executionTracker";
import {
  deviceLossOutcomeFromError,
  enrichDeviceLossOutcome,
} from "../../src/server/deviceLossOutcome";
import { serverConfig } from "../../src/utils/ServerConfig";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

const executionIds: string[] = [];
const previousPlanActive = serverConfig.isPlanExecutionActive();
afterEach(() => {
  for (const id of executionIds.splice(0)) {
    executionTracker.endExecution(id);
  }
  serverConfig.setPlanExecutionActive(previousPlanActive);
});

function harness() {
  serverConfig.setPlanExecutionActive(true);
  const timer = new FakeTimer();
  const incidents = new InMemoryEmulatorLossIncidentStore(timer, new FakeIdGenerator());
  const device: PooledDevice = {
    id: "emulator-5554",
    name: "Pixel",
    platform: "android",
    sessionId: "plan:main",
    status: "busy",
    incarnation: 1,
    assignmentCount: 1,
    lastUsedAt: 0,
    errorCount: 0,
    avdName: "Pixel",
    androidImage: { name: "Pixel", platform: "android" },
  };
  const peer = { ...device, id: "emulator-5556", avdName: "Pixel_2", sessionId: "peer" };
  const devices = new Map([
    [device.id, device],
    [peer.id, peer],
  ]);
  class Manager extends FakeDeviceManager {
    calls: BootedDeviceDiscoveryOptions[] = [];
    onDiscovery = () => {};
    offlineDeviceIds = new Set<string>();
    onOfflineProbe = () => {};
    offlineProbeError: Error | undefined;
    override async getBootedDevicesDetailed(
      platform: Parameters<FakeDeviceManager["getBootedDevicesDetailed"]>[0],
      options: BootedDeviceDiscoveryOptions = {},
    ) {
      this.calls.push(options);
      this.onDiscovery();
      return super.getBootedDevicesDetailed(platform);
    }
    async getAndroidOfflineDeviceIds() {
      this.onOfflineProbe();
      if (this.offlineProbeError) {
        throw this.offlineProbeError;
      }
      return this.offlineDeviceIds;
    }
    async recoverAndroidOfflineDevices() {
      throw new Error("Plan path must not recover devices");
    }
  }
  const manager = new Manager([], [{ deviceId: peer.id, name: "Pixel_2", platform: "android" }]);
  let reserved = false;
  let leased = false;
  let onReservation = () => {};
  let onIncident = () => {};
  const daemon: Daemon = Object.create(Daemon.prototype);
  Object.assign(daemon, {
    timer,
    deviceDisconnectMonitor: null,
    deviceDisconnectMisses: new Map(),
    deviceDisconnectMissIncarnations: new Map(),
    confirmedDisconnectedDeviceIds: new Set(),
    forceDisconnectedDeviceIds: new Set([device.id]),
    forceDisconnectedDeviceGenerations: new Map(),
    offlineRecoveryAttemptedDeviceIds: new Set(),
    offlineRecoveryAttemptedIncarnations: new Map(),
    deferredSessionRecoverySweeps: new Set(),
    devicePool: {
      getAllDevices: () => [...devices.values()],
      getDevice: (id: string) => devices.get(id) ?? null,
      isDeviceLeasedForAndroidStartup: () => leased,
      isShutdownReservationHeld: async () => {
        onReservation();
        return reserved;
      },
      recordEmulatorLossIncident: async (id: string, detectionPath: EmulatorLossDetectionPath) => {
        const incident = await incidents.open({
          deviceId: id,
          avdName: devices.get(id)?.avdName,
          detectionPath,
          lastAdbState: "absent",
          session: {
            sessionUuid: "plan:main",
            state: "active",
            lastHeartbeatMs: 0,
            hasReceivedHeartbeat: true,
            heartbeatTimeoutMs: 10_000,
          },
          recoveryPolicy: { onLoss: false, maxAttempts: 1 },
        });
        onIncident();
        return incident.id;
      },
      finishEmulatorLossIncident: async (id: string | undefined) => {
        if (id) {
          await incidents.completeRecovery(id, "not-attempted");
        }
      },
    },
    sessionManager: {
      getAllSessions: () => [],
      getDeviceLabels: (id: string) =>
        id === "plan" ? { main: "plan:main", sibling: "plan:sibling" } : undefined,
      getSessionForDevice: (id: string) => devices.get(id)?.sessionId ?? null,
    },
  });
  daemon["startDeviceDisconnectMonitor"](manager, async () => []);
  const start = (tool: string, id = device.id, sessionUuid = "plan") => {
    const execution = executionTracker.startExecution(tool, undefined, sessionUuid);
    executionIds.push(execution.id);
    executionTracker.bindDeviceExecution(execution.id, id);
    return execution;
  };
  return {
    daemon,
    timer,
    manager,
    device,
    peer,
    devices,
    incidents,
    start,
    set reserved(value: boolean) {
      reserved = value;
    },
    set leased(value: boolean) {
      leased = value;
    },
    set onReservation(value: () => void) {
      onReservation = value;
    },
    set onIncident(value: () => void) {
      onIncident = value;
    },
    async tick() {
      timer.advanceTime(5_000);
      await daemon["deviceDisconnectMonitor"]!.run();
      expect(timer.getSleepHistory()).toEqual([]);
    },
  };
}

describe("confirmed plan device loss", () => {
  test("repeated checks cannot confirm before the named window elapses", async () => {
    const h = harness();
    const plan = h.start("executePlan");
    const check = h.daemon["createPlanDeviceLossCheck"](h.manager);
    const missing = {
      disconnected: [],
      missed: [{ deviceId: h.device.id, misses: 1 }],
      skippedAllDiscoveryFailed: false,
    };
    const present = new Set([h.peer.id]);
    await check(missing, present);
    await check(missing, present);
    h.timer.setCurrentTime(PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS - 1);
    await check(missing, present);
    expect(plan.abortController.signal.aborted).toBe(false);
    expect(await h.incidents.list()).toEqual([]);
    h.timer.setCurrentTime(PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS);
    await check(missing, present);
    expect(plan.abortController.signal.aborted).toBe(true);
    await check(missing, present);
    expect(await h.incidents.list()).toHaveLength(1);
    expect(h.timer.getSleepHistory()).toEqual([]);
  });

  test("persistent offline rows are inconclusive and break the absence window", async () => {
    const h = harness();
    const plan = h.start("executePlan");
    await h.tick();
    h.manager.offlineDeviceIds.add(h.device.id);
    await h.tick();
    await h.tick();
    expect(plan.abortController.signal.aborted).toBe(false);
    expect(await h.incidents.list()).toEqual([]);
    h.manager.offlineDeviceIds.clear();
    await h.tick();
    expect(plan.abortController.signal.aborted).toBe(false);
    await h.tick();
    expect(plan.abortController.signal.aborted).toBe(true);
    expect(await h.incidents.list()).toHaveLength(1);
  });

  test("a failed offline probe breaks the absence window", async () => {
    const h = harness();
    const plan = h.start("executePlan");
    await h.tick();
    h.manager.offlineProbeError = new Error("offline probe unavailable");
    await h.tick();
    expect(plan.abortController.signal.aborted).toBe(false);
    h.manager.offlineProbeError = undefined;
    await h.tick();
    expect(plan.abortController.signal.aborted).toBe(false);
    await h.tick();
    expect(plan.abortController.signal.aborted).toBe(true);
  });

  test.each(["leased", "reserved"])(
    "restart %s grace breaks a previously pending loss",
    async (state) => {
      const h = harness();
      const plan = h.start("executePlan");
      await h.tick();
      h[state] = true;
      await h.tick();
      h[state] = false;
      await h.tick();
      expect(plan.abortController.signal.aborted).toBe(false);
      await h.tick();
      expect(plan.abortController.signal.aborted).toBe(true);
    },
  );

  test("cancels only the owning plan once per loss and reports the existing incident outcome", async () => {
    const h = harness();
    const plan = h.start("executePlan");
    executionTracker.bindDeviceExecution(plan.id, h.peer.id);
    const cancel = spyOn(executionTracker, "cancelDeviceExecutions");
    try {
      await h.tick();
      expect(plan.abortController.signal.aborted).toBe(false);
      expect(await h.incidents.list()).toEqual([]);
      await h.tick();
      expect(plan.abortController.signal.aborted).toBe(true);
      const outcome = deviceLossOutcomeFromError(plan.cancelReason, "plan");
      expect(outcome).toMatchObject({ code: "device_lost", deviceId: h.device.id });
      const incident = await h.incidents.get(outcome!.incidentId!);
      expect(enrichDeviceLossOutcome(outcome!, incident)).toMatchObject({
        detectionPath: "adb-transport-failure",
        avdName: "Pixel",
        sessionState: "active",
        recovery: { status: "not-attempted", attempts: 0 },
      });
      await h.tick();
      expect(cancel).toHaveBeenCalledTimes(1);
      expect(await h.incidents.list()).toHaveLength(1);
      expect(h.manager.calls.slice(0, 2)).toEqual([
        { bypassAndroidDeviceListCache: false },
        { bypassAndroidDeviceListCache: true },
      ]);
      expect(h.daemon["deviceDisconnectMisses"].get(h.device.id)).toBe(1);
      expect(h.daemon["confirmedDisconnectedDeviceIds"].size).toBe(0);
      // A fresh presence observation ends the episode even without replacing the object.
      h.manager.bootedDevices.push({ deviceId: h.device.id, name: "Pixel", platform: "android" });
      await h.tick();
      executionTracker.endExecution(plan.id);
      const nextPlan = h.start("executePlan");
      h.manager.bootedDevices = [{ deviceId: h.peer.id, name: "Pixel_2", platform: "android" }];
      await h.tick();
      expect(nextPlan.abortController.signal.aborted).toBe(false);
      await h.tick();
      expect(nextPlan.abortController.signal.aborted).toBe(true);
      expect(cancel).toHaveBeenCalledTimes(2);
    } finally {
      cancel.mockRestore();
    }
  });

  test("adbd restart blip: absent at the first tick, present at the later re-probe", async () => {
    const h = harness();
    const plan = h.start("executePlan");
    await h.tick();
    expect(plan.abortController.signal.aborted).toBe(false);
    h.manager.onDiscovery = () => {
      if (h.manager.calls.length === 4) {
        h.manager.bootedDevices.push({ deviceId: h.device.id, name: "Pixel", platform: "android" });
      }
    };
    await h.tick();
    expect(h.manager.calls).toHaveLength(4);
    expect(h.timer.now()).toBe(2 * PLAN_DEVICE_LOSS_CONFIRMATION_WINDOW_MS);
    expect(plan.abortController.signal.aborted).toBe(false);
    expect(await h.incidents.list()).toEqual([]);
  });

  test.each([true, false])(
    "whole owned cohort vanished: no cancellation (raw signal=%s)",
    async (rawSignal) => {
      const h = harness();
      const plan = h.start("executePlan");
      h.manager.bootedDevices = [];
      if (!rawSignal) {
        h.daemon["forceDisconnectedDeviceIds"].clear();
      }
      await h.tick();
      await h.tick();
      expect(h.manager.calls).toHaveLength(4);
      expect(plan.abortController.signal.aborted).toBe(false);
      expect(await h.incidents.list()).toEqual([]);
    },
  );

  test("recovery, unrelated same-session work, other plans and devices are untouched", async () => {
    const h = harness();
    const plan = h.start("executePlan");
    const untouched = [
      h.start("startDevice"),
      h.start("observe"),
      h.start("executePlan", h.device.id, "other-plan"),
      h.start("executePlan", h.peer.id),
    ];
    await h.tick();
    await h.tick();
    expect(plan.abortController.signal.aborted).toBe(true);
    for (const execution of untouched) {
      expect(execution.abortController.signal.aborted).toBe(false);
      // Scoped loss must not revoke later bindings of unrelated work either.
      expect(() => executionTracker.bindDeviceExecution(execution.id, h.device.id)).not.toThrow();
    }
  });

  test.each([
    "reservation",
    "confirmation-reservation",
    "cancellation-reservation",
    "discovery",
    "offline-probe",
    "incident",
  ])("incarnation changes across %s await: no stale cancellation", async (boundary) => {
    const h = harness();
    const plan = h.start("executePlan");
    await h.tick();
    h.manager.calls = [];
    const replace = () => h.devices.set(h.device.id, { ...h.device, incarnation: 2 });
    if (boundary === "reservation") {
      h.onReservation = replace;
    }
    if (boundary === "confirmation-reservation" || boundary === "cancellation-reservation") {
      let reservationCalls = 0;
      const replaceAt = boundary === "confirmation-reservation" ? 2 : 3;
      h.onReservation = () => {
        if (++reservationCalls === replaceAt) {
          replace();
        }
      };
    }
    if (boundary === "discovery") {
      h.manager.onDiscovery = () => {
        if (h.manager.calls.length === 2) {
          replace();
        }
      };
    }
    if (boundary === "offline-probe") {
      h.manager.onOfflineProbe = replace;
    }
    if (boundary === "incident") {
      h.onIncident = replace;
    }
    await h.tick();
    expect(h.devices.get(h.device.id)?.incarnation).toBe(2);
    expect(plan.abortController.signal.aborted).toBe(false);
  });

  test("failed fresh discovery is inconclusive", async () => {
    const h = harness();
    const plan = h.start("executePlan");
    await h.tick();
    h.manager.calls = [];
    h.manager.onDiscovery = () => {
      if (h.manager.calls.length === 2) {
        h.manager.failedPlatforms.add("android");
      }
    };
    await h.tick();
    expect(h.manager.calls).toHaveLength(2);
    expect(plan.abortController.signal.aborted).toBe(false);
    expect(await h.incidents.list()).toEqual([]);
  });

  test.each(["discovery", "incident"])(
    "restart acquires shutdown reservation during %s: keep the plan alive",
    async (boundary) => {
      const h = harness();
      const plan = h.start("executePlan");
      await h.tick();
      h.manager.calls = [];
      if (boundary === "discovery") {
        h.manager.onDiscovery = () => {
          if (h.manager.calls.length === 2) {
            h.reserved = true;
          }
        };
      } else {
        h.onIncident = () => {
          h.reserved = true;
        };
      }
      await h.tick();
      expect(h.manager.calls).toHaveLength(2);
      expect(plan.abortController.signal.aborted).toBe(false);
    },
  );

  test.each(["incarnation", "assignmentCount"])(
    "in-place %s change across discovery cannot cancel captured work",
    async (field) => {
      const h = harness();
      const plan = h.start("executePlan");
      await h.tick();
      h.manager.calls = [];
      h.manager.onDiscovery = () => {
        if (h.manager.calls.length === 2) {
          h.device[field]++;
        }
      };
      await h.tick();
      expect(h.device[field]).toBe(2);
      expect(plan.abortController.signal.aborted).toBe(false);
    },
  );

  test.each(["idle", "error", "leased", "reserved"])(
    "keeps plan-driven restart grace when %s",
    async (state) => {
      const h = harness();
      const plan = h.start("executePlan");
      if (state === "idle" || state === "error") {
        h.device.status = state;
      }
      if (state === "leased") {
        h.leased = true;
      }
      if (state === "reserved") {
        h.reserved = true;
      }
      await h.tick();
      await h.tick();
      expect(plan.abortController.signal.aborted).toBe(false);
      expect(h.manager.calls).toHaveLength(2);
      expect(await h.incidents.list()).toEqual([]);
    },
  );
});
