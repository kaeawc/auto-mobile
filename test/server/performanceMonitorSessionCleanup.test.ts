import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { SessionManager } from "../../src/daemon/sessionManager";
import { PerformanceMonitor } from "../../src/features/performance/PerformanceMonitor";
import { registerPerformanceMonitorSessionCleanup } from "../../src/server/performanceMonitorSessionCleanup";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeTimer } from "../fakes/FakeTimer";

type CleanupManager = Parameters<typeof registerPerformanceMonitorSessionCleanup>[0];
type ReleaseCallback = Parameters<SessionManager["onSessionRelease"]>[0];
type UnboundCallback = Parameters<SessionManager["onSessionDeviceUnbound"]>[0];

class FakeSessionManager implements CleanupManager {
  releaseCallbacks: ReleaseCallback[] = [];
  unboundCallbacks: UnboundCallback[] = [];

  onSessionRelease(callback: ReleaseCallback): void {
    this.releaseCallbacks.push(callback);
  }

  onSessionDeviceUnbound(callback: UnboundCallback): void {
    this.unboundCallbacks.push(callback);
  }

  release(sessionId: string, deviceId: string): void {
    for (const callback of this.releaseCallbacks) {
      callback(sessionId, deviceId, "explicit-release", {
        sessionId,
        deviceId,
        releaseReason: "explicit-release",
        releasedAtMs: 0,
        terminal: true,
        heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: false, timeoutMs: 0, ageMs: 0 },
      });
    }
  }

  unbind(sessionId: string, deviceId: string): void {
    for (const callback of this.unboundCallbacks) {
      callback(sessionId, deviceId);
    }
  }
}

describe("registerPerformanceMonitorSessionCleanup", () => {
  const deviceId = "emulator-5554";
  let timer: FakeTimer;
  let adb: FakeAdbClient;
  let monitor: PerformanceMonitor;
  let manager: FakeSessionManager;

  const gfxinfoPolls = () => adb.getCommandCount("dumpsys gfxinfo");

  beforeEach(() => {
    timer = new FakeTimer();
    adb = new FakeAdbClient();
    adb.setCommandResult("shell pidof 'com.example.app'", "12345\n");
    monitor = new PerformanceMonitor(timer, new FakeAdbClientFactory(adb), () => ({
      pushPerformanceData: () => undefined,
    }));
    monitor.start();
    monitor.startMonitoring(deviceId, "com.example.app");
    manager = new FakeSessionManager();
    registerPerformanceMonitorSessionCleanup(manager, { monitor: () => monitor });
  });

  afterEach(() => {
    monitor.stop();
    timer.reset();
  });

  test("keeps polling a monitored device while its session is live", async () => {
    await timer.advanceTimeAsync(PerformanceMonitor.TICK_INTERVAL_MS);
    expect(gfxinfoPolls()).toBe(1);
    await timer.advanceTimeAsync(PerformanceMonitor.TICK_INTERVAL_MS);
    expect(gfxinfoPolls()).toBe(2);
  });

  test("stops polling the device once its session is released", async () => {
    await timer.advanceTimeAsync(PerformanceMonitor.TICK_INTERVAL_MS);
    expect(gfxinfoPolls()).toBe(1);

    manager.release("session-1", deviceId);
    await timer.advanceTimeAsync(PerformanceMonitor.TICK_INTERVAL_MS * 10);

    expect(gfxinfoPolls()).toBe(1);
    expect(monitor.getMonitoredDeviceCount()).toBe(0);
  });

  test("stops polling the device when its session moves to another device", async () => {
    manager.unbind("session-1", deviceId);
    await timer.advanceTimeAsync(PerformanceMonitor.TICK_INTERVAL_MS * 10);

    expect(gfxinfoPolls()).toBe(0);
    expect(monitor.getMonitoredDeviceCount()).toBe(0);
  });

  test("leaves other devices' monitoring alone", async () => {
    monitor.startMonitoring("emulator-5556", "com.example.app");

    manager.release("session-1", deviceId);

    expect(monitor.getMonitoredDeviceCount()).toBe(1);
  });
});
