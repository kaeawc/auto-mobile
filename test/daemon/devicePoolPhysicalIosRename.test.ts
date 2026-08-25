import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { DevicePool } from "../../src/daemon/devicePool";
import { SessionManager } from "../../src/daemon/sessionManager";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeInstalledAppsRepository } from "../fakes/FakeInstalledAppsRepository";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import type { BootedDevice, Platform } from "../../src/models";
import { DefaultRetryExecutor } from "../../src/utils/retry/RetryExecutor";

/**
 * A physical iPhone can change its display name without the hardware or the
 * connection changing: the user renames it in Settings, or a `devicectl`
 * payload omits `deviceProperties.name` and `DevicectlDeviceLister` falls back
 * to the marketing name. Neither is a new device (#5690).
 */
const PHYSICAL_IPHONE_UDID = "00008030-001C2D3E1234567A";
const LEGACY_IPHONE_UDID = "a".repeat(40);
const SIMULATOR_UDID = "1E2A3B4C-5D6E-4F70-8192-A3B4C5D6E7F8";

describe("DevicePool physical iOS rename (#5690)", () => {
  let devicePool: DevicePool;
  let sessionManager: SessionManager;
  let fakeTimer: FakeTimer;
  let fakeDeviceManager: FakeDeviceManager;

  const booted = (deviceId: string, platform: Platform, name: string): BootedDevice => ({
    name,
    platform,
    deviceId,
  });

  const initialize = async (device: BootedDevice): Promise<void> => {
    fakeDeviceManager.bootedDevices = [device];
    await devicePool.initializeWithDevices([device]);
  };

  const republishAs = async (device: BootedDevice): Promise<void> => {
    fakeDeviceManager.bootedDevices = [device];
    await devicePool.refreshDevices();
  };

  beforeEach(() => {
    fakeTimer = new FakeTimer();
    sessionManager = new SessionManager(fakeTimer, new FakeDeviceSessionPersistence());
    fakeDeviceManager = new FakeDeviceManager();
    devicePool = new DevicePool(
      sessionManager,
      "test-daemon-session-id",
      fakeTimer,
      new FakeInstalledAppsRepository(),
      fakeDeviceManager,
      new DefaultRetryExecutor(fakeTimer),
    );
  });

  afterEach(() => {
    sessionManager.stopCleanupTimer();
  });

  test("keeps the pooled incarnation and active session when a physical iPhone is renamed", async () => {
    const original = booted(PHYSICAL_IPHONE_UDID, "ios", "Jason's iPhone");
    await initialize(original);
    await devicePool.bindOrReuseDeviceSession("owner-session", PHYSICAL_IPHONE_UDID, "ios");
    const incarnation = devicePool.getDevice(PHYSICAL_IPHONE_UDID)?.incarnation;
    expect(incarnation).toBeDefined();

    await republishAs(booted(PHYSICAL_IPHONE_UDID, "ios", "iPhone 15 Pro"));

    const pooled = devicePool.getDevice(PHYSICAL_IPHONE_UDID);
    expect(pooled?.incarnation).toBe(incarnation!);
    expect(pooled?.sessionId).toBe("owner-session");
    // The display name is mutable metadata: updated in place, never identity.
    expect(pooled?.name).toBe("iPhone 15 Pro");
    expect(sessionManager.getSession("owner-session")?.assignedDevice).toBe(PHYSICAL_IPHONE_UDID);
  });

  test("keeps a legacy 40-hex physical iPhone across a rename too", async () => {
    await initialize(booted(LEGACY_IPHONE_UDID, "ios", "Old iPhone"));
    const incarnation = devicePool.getDevice(LEGACY_IPHONE_UDID)?.incarnation;

    await republishAs(booted(LEGACY_IPHONE_UDID, "ios", "iPhone 8"));

    const pooled = devicePool.getDevice(LEGACY_IPHONE_UDID);
    expect(pooled?.incarnation).toBe(incarnation!);
    expect(pooled?.name).toBe("iPhone 8");
  });

  test("still replaces a physical iOS UDID whose platform changes", async () => {
    await initialize(booted(PHYSICAL_IPHONE_UDID, "ios", "Jason's iPhone"));
    const incarnation = devicePool.getDevice(PHYSICAL_IPHONE_UDID)?.incarnation;

    await republishAs(booted(PHYSICAL_IPHONE_UDID, "android", "Jason's iPhone"));

    const pooled = devicePool.getDevice(PHYSICAL_IPHONE_UDID);
    expect(pooled?.platform).toBe("android");
    expect(pooled?.incarnation).not.toBe(incarnation!);
  });

  test("leaves simulator rename semantics alone: a renamed simulator is replaced", async () => {
    await initialize(booted(SIMULATOR_UDID, "ios", "iPhone 15"));
    const incarnation = devicePool.getDevice(SIMULATOR_UDID)?.incarnation;

    await republishAs(booted(SIMULATOR_UDID, "ios", "iPhone 16"));

    const pooled = devicePool.getDevice(SIMULATOR_UDID);
    expect(pooled?.incarnation).not.toBe(incarnation!);
    expect(pooled?.name).toBe("iPhone 16");
  });

  test("leaves non-emulator Android name tolerance alone: a renamed Android serial is replaced", async () => {
    await initialize(booted("R5CT1234ABC", "android", "Pixel 8"));
    const incarnation = devicePool.getDevice("R5CT1234ABC")?.incarnation;

    await republishAs(booted("R5CT1234ABC", "android", "Pixel 9"));

    const pooled = devicePool.getDevice("R5CT1234ABC");
    expect(pooled?.incarnation).not.toBe(incarnation!);
  });
});
