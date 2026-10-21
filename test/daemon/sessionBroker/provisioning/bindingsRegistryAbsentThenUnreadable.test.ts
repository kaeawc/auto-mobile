import { beforeEach, describe, expect, test } from "bun:test";
import { createDevicePoolDependencies } from "../../../helpers/devicePoolDependencies";
import { RegistryBindingExclusion } from "../../../../src/daemon/sessionBroker/provisioning/exclusion";
import { BindingDiscoveryIncompleteError } from "../../../../src/daemon/sessionBroker/provisioning/refusal";
import type { BindingRegistry } from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { DevicePool } from "../../../../src/daemon/devicePool";
import { SessionManager } from "../../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../../fakes/FakeDeviceUtils";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { assignBindingDevice } from "./bindingFixtures";

/**
 * Hunt (bindings, 2026-10-10): "if the registry has never been readable, allocation refuses
 * with retryable discovery_incomplete rather than treat unknown as free". A daemon that refreshed
 * once while the host registry did not exist yet keeps that placeholder (empty) snapshot as its
 * "last good snapshot". When the registry is created afterwards (another daemon on the host, or
 * this daemon's first managed proxy) and the first real read fails, the refresh swallows the
 * failure and every binding device reads as free: control, input and selector-based starts proceed.
 */
describe("hunt: registry absent at startup, then present but unreadable", () => {
  const DEVICE = { name: "iPhone", deviceId: "IOS-1", platform: "ios" as const };
  let timer: FakeTimer;
  let exists: boolean;
  let failOpen: boolean;
  let registry: FakeBindingRegistry;

  const open = async (): Promise<BindingRegistry> => {
    if (failOpen) {
      throw new Error("file is not a database");
    }
    return registry;
  };

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    exists = false;
    failOpen = false;
    registry = new FakeBindingRegistry(timer);
  });

  async function poolOver(exclusion: RegistryBindingExclusion): Promise<DevicePool> {
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const deviceManager = new FakeDeviceUtils();
    deviceManager.setBootedDevices("ios", [DEVICE]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "bindings-hunt-absent-unreadable", {
        timer,
        deviceManager,
        bindingExclusion: exclusion,
      }),
    );
    await pool.initializeWithDevices([DEVICE]);
    return pool;
  }

  const controlCheck = (pool: DevicePool) =>
    pool.assertNotAssignedToBinding({
      action: "tapOn",
      deviceId: DEVICE.deviceId,
      platform: "ios",
    });

  test("the first read of a registry that now exists fails closed, not open on the placeholder snapshot", async () => {
    const exclusion = new RegistryBindingExclusion(open, timer, () => exists);
    const pool = await poolOver(exclusion);
    // Startup on a host with no registry: nothing is managed.
    await controlCheck(pool);

    // A binding now holds the device, but this daemon cannot read the registry.
    await assignBindingDevice(registry, "ios", DEVICE.deviceId);
    exists = true;
    failOpen = true;

    const error = await controlCheck(pool).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    // The registry has never been read, so the binding device is unknown, never free.
    expect(error).toBeInstanceOf(BindingDiscoveryIncompleteError);
  });

  test("selector-based starts do not treat the unreadable registry's devices as unmanaged", async () => {
    const exclusion = new RegistryBindingExclusion(open, timer, () => exists);
    const pool = await poolOver(exclusion);
    expect(await pool.bindingStableIds("ios")).toEqual(new Set());

    await assignBindingDevice(registry, "ios", DEVICE.deviceId);
    exists = true;
    failOpen = true;

    await expect(pool.bindingStableIds("ios")).rejects.toMatchObject({
      code: "discovery_incomplete",
    });
  });
});
