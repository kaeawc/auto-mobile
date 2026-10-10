import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createDevicePoolDependencies } from "../../helpers/devicePoolDependencies";
import { AbandonedScopeReclaimer } from "../../../src/daemon/managedSlots/abandonedScopeReclaimer";
import { assertInputNotOnForeignManagedSlotDevice } from "../../../src/daemon/inputDeviceOwnership";
import {
  createDefaultManagedSlotExclusion,
  RegistryManagedSlotExclusion,
} from "../../../src/daemon/managedSlots/managedSlotExclusion";
import { ManagedSlotDiscoveryIncompleteError } from "../../../src/daemon/managedSlots/managedSlotRefusal";
import { SlotScopeReset } from "../../../src/daemon/managedSlots/slotScopeReset";
import type { SlotRegistry } from "../../../src/daemon/managedSlots/slotRegistry";
import { defaultSlotRegistryPath } from "../../../src/daemon/managedSlots/sqliteSlotRegistry";
import { DevicePool } from "../../../src/daemon/devicePool";
import { SessionManager } from "../../../src/daemon/sessionManager";
import { FakeDeviceSessionPersistence } from "../../fakes/FakeDeviceSessionPersistence";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { assignManagedSlotDevice } from "./managedSlotFixtures";

// Most hosts never use managed slots. A registry that does not exist yet means "nothing is
// managed": no refusal anywhere, and nothing creates the file just by reading. Only a registry
// that exists but cannot be read fails closed (discovery_incomplete).

const DEVICE = { name: "iPhone", deviceId: "IOS-1", platform: "ios" as const };

describe("managed-slot registry absence", () => {
  let timer: FakeTimer;
  let opens: number;
  let exists: boolean;
  let registry: FakeSlotRegistry;
  let failOpen: boolean;

  const open = async (): Promise<SlotRegistry> => {
    opens++;
    if (failOpen) {
      throw new Error("file is not a database");
    }
    return registry;
  };

  beforeEach(() => {
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    opens = 0;
    exists = false;
    failOpen = false;
    registry = new FakeSlotRegistry(timer);
  });

  async function poolOver(exclusion: RegistryManagedSlotExclusion) {
    const sessionManager = new SessionManager(timer, new FakeDeviceSessionPersistence());
    sessionManager.stopCleanupTimer();
    const deviceManager = new FakeDeviceUtils();
    deviceManager.setBootedDevices("ios", [DEVICE]);
    const pool = new DevicePool(
      createDevicePoolDependencies(sessionManager, "registry-absence", {
        timer,
        deviceManager,
        managedSlotExclusion: exclusion,
      }),
    );
    await pool.initializeWithDevices([DEVICE]);
    return { pool, sessionManager };
  }

  const controlCheck = (pool: DevicePool) =>
    pool.assertNotAssignedToManagedSlot({
      action: "tapOn",
      deviceId: DEVICE.deviceId,
      platform: "ios",
    });

  const inputCheck = (pool: DevicePool, sessionManager: SessionManager) =>
    assertInputNotOnForeignManagedSlotDevice({
      action: "input/tap",
      deviceId: DEVICE.deviceId,
      platform: "ios",
      requesterSessionUuid: undefined,
      sessionManager,
      gate: pool,
    });

  test("(a, b) an absent registry is an empty snapshot: no refusal, never opened", async () => {
    const exclusion = new RegistryManagedSlotExclusion(open, timer, () => exists);
    const { pool, sessionManager } = await poolOver(exclusion);

    await controlCheck(pool);
    await inputCheck(pool, sessionManager);
    expect(await pool.managedSlotStableIds("ios")).toEqual(new Set());
    expect(opens).toBe(0);
  });

  test("a registry created later is picked up on the next refresh", async () => {
    const exclusion = new RegistryManagedSlotExclusion(open, timer, () => exists);
    const { pool } = await poolOver(exclusion);
    await controlCheck(pool);

    await assignManagedSlotDevice(registry, "ios", DEVICE.deviceId);
    exists = true;

    await expect(controlCheck(pool)).rejects.toMatchObject({
      code: "device_assigned_to_managed_slot",
    });
    expect(opens).toBe(1);
  });

  test("(c) a registry that exists but cannot be read fails closed on control and input", async () => {
    exists = true;
    failOpen = true;
    const { pool, sessionManager } = await poolOver(
      new RegistryManagedSlotExclusion(open, timer, () => exists),
    );

    await expect(controlCheck(pool)).rejects.toBeInstanceOf(ManagedSlotDiscoveryIncompleteError);
    await expect(inputCheck(pool, sessionManager)).rejects.toMatchObject({
      code: "discovery_incomplete",
    });
  });

  test("the abandoned-scope sweep and the operator reset never open an absent registry", async () => {
    const reclaimer = new AbandonedScopeReclaimer({
      registry: open,
      registryExists: () => exists,
      journal: () => {
        throw new Error("must not drive the journal");
      },
      timer,
    });
    expect(await reclaimer.sweep()).toEqual({ marked: [], deleted: [], blocked: [], skipped: [] });

    const reset = new SlotScopeReset({ registry: open, registryExists: () => exists, timer });
    expect(
      (await reset.reset({ runnerNamespace: "ns", runnerIncarnation: "boot-1" })).outcome,
    ).toBe("not_found");
    expect(opens).toBe(0);
  });

  describe("the daemon's default exclusion", () => {
    const key = "AUTOMOBILE_ADB_SERVER_COORDINATION_DIR";
    let saved: string | undefined;

    beforeEach(() => {
      saved = process.env[key];
      process.env[key] = join(tmpdir(), `am-slots-absent-${process.pid}-${Date.now()}`);
    });

    afterEach(() => {
      if (saved === undefined) {
        delete process.env[key];
      } else {
        process.env[key] = saved;
      }
    });

    test("reads an absent host registry as empty without creating it", async () => {
      const exclusion = createDefaultManagedSlotExclusion(timer);
      await exclusion.refresh();
      expect(exclusion.holderOf({ platform: "ios", stableIds: [DEVICE.deviceId] })).toBeUndefined();
      expect(existsSync(defaultSlotRegistryPath())).toBe(false);
      expect(existsSync(process.env[key]!)).toBe(false);
    });
  });
});
