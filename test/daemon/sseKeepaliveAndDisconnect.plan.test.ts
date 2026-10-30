import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { DaemonState } from "../../src/daemon/daemonState";
import { planDisconnectMonitorHarness } from "./helpers/planDisconnectMonitorHarness";
import { getPerformanceMonitor } from "../../src/features/performance/PerformanceMonitor";
import { serverConfig } from "../../src/utils/ServerConfig";
import { logger } from "../../src/utils/logger";
import { MISSING_DEVICE_MISS_THRESHOLD } from "../../src/daemon/deviceLossMisses";
const DEVICE_DISCONNECT_MISS_THRESHOLD = MISSING_DEVICE_MISS_THRESHOLD;
afterEach(() => DaemonState.getInstance().reset());
const PLAN_DISCONNECT_MISS_CAP = DEVICE_DISCONNECT_MISS_THRESHOLD - 2;

describe("disconnect monitor during plan execution", () => {
  test("reconciles before device-loss recovery when a plan ends during discovery", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    const planActive = spyOn(serverConfig, "isPlanExecutionActive");
    const stopMonitoring = spyOn(getPerformanceMonitor(), "stopMonitoring").mockImplementation(
      () => {},
    );
    try {
      serverConfig.setPlanExecutionActive(true);
      h.beginPlanRestart();
      h.daemon.disconnectMisses.set(h.device.id, DEVICE_DISCONNECT_MISS_THRESHOLD - 1);
      h.manager.onDiscovery = () => {
        h.endPlanRestart();
        serverConfig.setPlanExecutionActive(false);
      };
      await h.tick();
      expect(h.actions).toEqual([
        "reconcile",
        "stop-recording",
        "device-loss-recovery",
        "cancel:plan-session",
        `remove:${h.device.id}`,
      ]);
      expect(planActive).not.toHaveBeenCalled();
      expect(h.actions.indexOf("reconcile")).toBeLessThan(
        h.actions.indexOf("device-loss-recovery"),
      );
      expect(h.recordingsReader.calls).toBe(1);
      expect(h.manager.offlineProbeCalls).toBe(1);
      expect(stopMonitoring).toHaveBeenCalledWith(h.device.id);
    } finally {
      h.endPlanRestart();
      serverConfig.setPlanExecutionActive(previous);
      planActive.mockRestore();
      stopMonitoring.mockRestore();
    }
  });

  test("reconciles after offline recovery even when another plan starts", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    const planActive = spyOn(serverConfig, "isPlanExecutionActive");
    try {
      serverConfig.setPlanExecutionActive(false);
      h.manager.offlineDeviceIds.add(h.device.id);
      h.manager.onRecovery = () => {
        serverConfig.setPlanExecutionActive(true);
        h.manager.bootedDevices = [{ deviceId: h.device.id, name: "Pixel", platform: "android" }];
      };
      await h.tick();
      expect(h.actions).toEqual([
        "deferred-recovery",
        "reconcile",
        "offline-reconnect",
        "reconcile",
      ]);
      expect(planActive).not.toHaveBeenCalled();
      expect(h.daemon.disconnectMisses.size).toBe(0);
    } finally {
      h.endPlanRestart();
      serverConfig.setPlanExecutionActive(previous);
      planActive.mockRestore();
    }
  });

  test("reads recordings and preserves offline attempts while logging the own-plan cap once", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    const info = spyOn(logger, "info").mockImplementation(() => {});
    const debug = spyOn(logger, "debug").mockImplementation(() => {});
    const attempted = h.daemon.offlineRecoveryAttempted;
    const incarnations = h.daemon.offlineRecoveryIncarnations;
    attempted.add(h.device.id);
    incarnations.set(h.device.id, h.device.incarnation);
    try {
      serverConfig.setPlanExecutionActive(true);
      h.beginPlanRestart(h.devices.map(({ id }) => id));
      for (let i = 0; i < DEVICE_DISCONNECT_MISS_THRESHOLD + 1; i++) {
        await h.tick();
      }
      expect(h.recordingsReader.calls).toBe(DEVICE_DISCONNECT_MISS_THRESHOLD + 1);
      expect(h.manager.offlineProbeCalls).toBe(0);
      expect(h.daemon.offlineRecoveryAttempted).toBe(attempted);
      expect([...attempted]).toEqual([h.device.id]);
      expect(h.daemon.offlineRecoveryIncarnations).toBe(incarnations);
      expect(incarnations.get(h.device.id)).toBe(h.device.incarnation);
      const missMessage = `[DisconnectMonitor] Device ${h.device.id} not in booted list (absent, miss ${PLAN_DISCONNECT_MISS_CAP}/${DEVICE_DISCONNECT_MISS_THRESHOLD}, booted=0)`;
      expect(info.mock.calls.filter(([message]) => message === missMessage)).toHaveLength(1);
      expect(debug.mock.calls.filter(([message]) => message === missMessage)).toHaveLength(
        DEVICE_DISCONNECT_MISS_THRESHOLD,
      );
      expect(h.actions.every((action) => action === "reconcile")).toBe(true);
    } finally {
      h.endPlanRestart();
      serverConfig.setPlanExecutionActive(previous);
      info.mockRestore();
      debug.mockRestore();
    }
  });

  test("caps plan-time absence and cancels the lost session on the second inactive tick", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    const stopMonitoring = spyOn(getPerformanceMonitor(), "stopMonitoring").mockImplementation(
      () => {},
    );
    try {
      serverConfig.setPlanExecutionActive(true);
      h.beginPlanRestart(h.devices.map(({ id }) => id));
      for (let i = 0; i < DEVICE_DISCONNECT_MISS_THRESHOLD + 1; i++) {
        await h.tick();
        expect(h.daemon.disconnectMisses.get(h.device.id)).toBe(
          Math.min(i + 1, PLAN_DISCONNECT_MISS_CAP),
        );
        expect(h.actions.every((action) => action === "reconcile")).toBe(true);
        expect(h.daemon.confirmedDisconnected.size).toBe(0);
      }
      expect(h.manager.discoveryCalls).toBe(DEVICE_DISCONNECT_MISS_THRESHOLD + 1);
      expect(stopMonitoring).not.toHaveBeenCalled();
      h.endPlanRestart();
      serverConfig.setPlanExecutionActive(false);
      h.actions.length = 0;
      await h.tick();
      expect(h.actions).toEqual(["deferred-recovery", "reconcile"]);
      expect(h.daemon.disconnectMisses.get(h.device.id)).toBe(DEVICE_DISCONNECT_MISS_THRESHOLD - 1);
      expect(h.daemon.confirmedDisconnected.size).toBe(0);
      expect(stopMonitoring).not.toHaveBeenCalled();
      await h.tick();
      expect(h.actions).toContain("cancel:plan-session");
      expect(h.actions).toContain(`remove:${h.device.id}`);
      expect(h.actions).toContain("stop-recording");
      expect(h.daemon.confirmedDisconnected.has(h.device.id)).toBe(true);
      expect(h.daemon.disconnectMisses.has(h.device.id)).toBe(false);
      expect(stopMonitoring).toHaveBeenCalledWith(h.device.id);
    } finally {
      h.endPlanRestart();
      serverConfig.setPlanExecutionActive(previous);
      stopMonitoring.mockRestore();
    }
  });

  test("counts a newly booting device without reaping it and clears misses when boot completes", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    try {
      serverConfig.setPlanExecutionActive(true);
      h.beginPlanRestart(h.devices.map(({ id }) => id));
      for (let i = 0; i < DEVICE_DISCONNECT_MISS_THRESHOLD; i++) {
        await h.tick();
      }
      expect(h.daemon.disconnectMisses.get(h.device.id)).toBe(PLAN_DISCONNECT_MISS_CAP);
      expect(h.daemon.confirmedDisconnected.size).toBe(0);
      expect(h.actions.every((action) => action === "reconcile")).toBe(true);
      expect(h.device.status).toBe("busy");
      expect(h.device.sessionId).toBe("plan-session");
      h.manager.bootedDevices = [{ deviceId: h.device.id, name: "Pixel", platform: "android" }];
      // Present observations clear the accumulated absence even during allocation.
      await h.tick();
      expect(h.daemon.disconnectMisses.has(h.device.id)).toBe(false);
      expect(h.actions.every((action) => action === "reconcile")).toBe(true);
      h.manager.bootedDevices = [];
      for (let i = 0; i < DEVICE_DISCONNECT_MISS_THRESHOLD; i++) {
        await h.tick();
      }
      expect(h.daemon.disconnectMisses.get(h.device.id)).toBe(PLAN_DISCONNECT_MISS_CAP);
      h.manager.bootedDevices = [{ deviceId: h.device.id, name: "Pixel", platform: "android" }];
      h.endPlanRestart();
      serverConfig.setPlanExecutionActive(false);
      h.actions.length = 0;
      await h.tick();
      expect(h.daemon.disconnectMisses.has(h.device.id)).toBe(false);
      expect(h.daemon.confirmedDisconnected.size).toBe(0);
      expect(h.actions).not.toContain("cancel:plan-session");
      expect(h.actions).not.toContain(`remove:${h.device.id}`);
      for (let i = 0; i < DEVICE_DISCONNECT_MISS_THRESHOLD; i++) {
        await h.tick();
      }
      expect(h.actions).not.toContain("cancel:plan-session");
      expect(h.actions).not.toContain(`remove:${h.device.id}`);
      expect(h.actions).not.toContain("stop-recording");
    } finally {
      h.endPlanRestart();
      serverConfig.setPlanExecutionActive(previous);
    }
  });

  test("non-plan sessions retain all three discovery misses of restart grace", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    const stopMonitoring = spyOn(getPerformanceMonitor(), "stopMonitoring").mockImplementation(
      () => {},
    );
    try {
      serverConfig.setPlanExecutionActive(false);
      for (let misses = 1; misses < DEVICE_DISCONNECT_MISS_THRESHOLD; misses++) {
        await h.tick();
        expect(h.daemon.disconnectMisses.get(h.device.id)).toBe(misses);
        expect(h.actions).not.toContain("cancel:plan-session");
      }
      await h.tick();
      expect(h.actions).toContain("cancel:plan-session");
      expect(h.timer.getSleepHistory()).toEqual([]);
    } finally {
      stopMonitoring.mockRestore();
      serverConfig.setPlanExecutionActive(previous);
    }
  });

  test("counts misses while deferring offline reconnect and ADB reset cohort actions", async () => {
    const h = planDisconnectMonitorHarness();
    const previous = serverConfig.isPlanExecutionActive();
    try {
      h.devices.push({ ...h.device, id: "emulator-5556", avdName: "Pixel_2" });
      h.daemon.forcedDisconnected = new Set([h.device.id]);
      h.manager.offlineDeviceIds.add(h.device.id);
      serverConfig.setPlanExecutionActive(true);
      h.beginPlanRestart(h.devices.map(({ id }) => id));
      for (let i = 0; i < DEVICE_DISCONNECT_MISS_THRESHOLD; i++) {
        await h.tick();
      }
      expect(h.daemon.disconnectMisses.get(h.device.id)).toBe(PLAN_DISCONNECT_MISS_CAP);
      expect(h.daemon.disconnectMisses.get("emulator-5556")).toBe(PLAN_DISCONNECT_MISS_CAP);
      expect(h.daemon.confirmedDisconnected.size).toBe(0);
      expect(h.actions.every((action) => action === "reconcile")).toBe(true);
      expect(h.daemon.offlineRecoveryAttempted.size).toBe(0);
      h.manager.onRecovery = () => {
        h.manager.bootedDevices = [
          { deviceId: h.device.id, name: "Pixel", platform: "android" },
          { deviceId: "emulator-5556", name: "Pixel_2", platform: "android" },
        ];
      };
      h.endPlanRestart();
      serverConfig.setPlanExecutionActive(false);
      h.actions.length = 0;
      await h.tick();
      expect(h.daemon.disconnectMisses.size).toBe(0);
      expect(h.actions).toEqual([
        "deferred-recovery",
        "reconcile",
        "offline-reconnect",
        "reconcile",
      ]);
    } finally {
      h.endPlanRestart();
      serverConfig.setPlanExecutionActive(previous);
    }
  });
});
