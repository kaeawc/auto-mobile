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

  test("reconciles the pooled name when startDevice tolerates a rename before any refresh", async () => {
    const original = booted(PHYSICAL_IPHONE_UDID, "ios", "Jason's iPhone");
    await initialize(original);

    // The iPhone is renamed in Settings; discovery reports the new label to the
    // public start path while the pooled snapshot still carries the old one.
    const renamed = booted(PHYSICAL_IPHONE_UDID, "ios", "iPhone 15 Pro");
    fakeDeviceManager.bootedDevices = [renamed];
    await devicePool.bindOrReuseDeviceSession(
      "owner-session",
      PHYSICAL_IPHONE_UDID,
      "ios",
      undefined,
      undefined,
      renamed,
    );

    // Tolerating the rename must also fold it in: a stale PooledDevice.name
    // makes DeviceCriteriaMatcher match the obsolete label (#5690).
    expect(devicePool.getDevice(PHYSICAL_IPHONE_UDID)?.name).toBe("iPhone 15 Pro");
  });

  test("reconciles the pooled name when readiness reservation tolerates a rename", async () => {
    await initialize(booted(PHYSICAL_IPHONE_UDID, "ios", "Jason's iPhone"));

    const renamed = booted(PHYSICAL_IPHONE_UDID, "ios", "iPhone 15 Pro");
    fakeDeviceManager.bootedDevices = [renamed];
    await devicePool.reserveDeviceForReadiness(PHYSICAL_IPHONE_UDID, renamed);

    expect(devicePool.getDevice(PHYSICAL_IPHONE_UDID)?.name).toBe("iPhone 15 Pro");
  });

  test("does not rewrite a simulator's pooled name through the tolerated-match path", async () => {
    await initialize(booted(SIMULATOR_UDID, "ios", "iPhone 15"));

    // A simulator rename is a genuine identity change, so it must not be
    // quietly folded in behind a tolerated match.
    const renamed = booted(SIMULATOR_UDID, "ios", "iPhone 16");
    fakeDeviceManager.bootedDevices = [renamed];
    await expect(
      devicePool.bindOrReuseDeviceSession(
        "owner-session",
        SIMULATOR_UDID,
        "ios",
        undefined,
        undefined,
        renamed,
      ),
    ).rejects.toThrow(/identity mismatch/i);
    expect(devicePool.getDevice(SIMULATOR_UDID)?.name).toBe("iPhone 15");
  });

  test("a stale start snapshot never reverts a name a refresh already folded in", async () => {
    await initialize(booted(PHYSICAL_IPHONE_UDID, "ios", "Old iPhone"));
    // Capture the snapshot the start path will carry, then let a refresh land
    // the newer observation first.
    const staleSnapshot = booted(PHYSICAL_IPHONE_UDID, "ios", "Old iPhone");
    await republishAs(booted(PHYSICAL_IPHONE_UDID, "ios", "New iPhone"));
    expect(devicePool.getDevice(PHYSICAL_IPHONE_UDID)?.name).toBe("New iPhone");

    // The start path now acquires the assignment mutex with its older snapshot.
    // The mutex serializes the writes but says nothing about which observation
    // is newer, so reconciliation must not write the obsolete label back.
    await devicePool.bindOrReuseDeviceSession(
      "owner-session",
      PHYSICAL_IPHONE_UDID,
      "ios",
      undefined,
      undefined,
      staleSnapshot,
    );

    expect(devicePool.getDevice(PHYSICAL_IPHONE_UDID)?.name).toBe("New iPhone");
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
