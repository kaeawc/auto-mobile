import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { PerformanceMonitor } from "../../src/features/performance/PerformanceMonitor";
import { registerPerformanceMonitorSessionCleanup } from "../../src/daemon/performanceMonitorSessionCleanup";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeSessionCleanupManager } from "../fakes/FakeSessionCleanupManager";
import { FakeTimer } from "../fakes/FakeTimer";

describe("registerPerformanceMonitorSessionCleanup", () => {
  const deviceId = "emulator-5554";
  let timer: FakeTimer;
  let adb: FakeAdbClient;
  let monitor: PerformanceMonitor;
  let manager: FakeSessionCleanupManager;

  const gfxinfoPolls = () => adb.getCommandCount("dumpsys gfxinfo");

  beforeEach(() => {
    timer = new FakeTimer();
    adb = new FakeAdbClient();
    adb.setCommandResult("shell pidof 'com.example.app'", "12345\n");
    monitor = new PerformanceMonitor(timer, {
      adbClientFactory: new FakeAdbClientFactory(adb),
      serverGetter: () => ({
        pushPerformanceData: () => undefined,
      }),
    });
    monitor.start();
    monitor.startMonitoring(deviceId, "com.example.app");
    manager = new FakeSessionCleanupManager();
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

  test("identity replacement stops host polling without another adb command", async () => {
    manager.release("session-1", deviceId, false, true);
    await timer.advanceTimeAsync(PerformanceMonitor.TICK_INTERVAL_MS * 10);
    expect(gfxinfoPolls()).toBe(0);
    expect(adb.getCommandCount("shell")).toBe(0);
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
