import { afterAll, describe, expect } from "bun:test";
import { Database } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../../../src/db/bunSqliteDialect";
import { migrateBindingRegistry } from "../../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import {
  SqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import { RegistryBindingResourceBudget } from "../../../../src/daemon/sessionBroker/provisioning/resourceBudget";
import { DeviceManagerBindingInventory } from "../../../../src/daemon/sessionBroker/provisioning/reconcilerPorts";
import { MultiPlatformDeviceManager } from "../../../../src/devices/deviceUtils";
import { AndroidEmulatorUnavailableError } from "../../../../src/utils/android-cmdline-tools/AndroidEmulatorClient";
import { SimctlUnavailableError } from "../../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { SimCtlClient } from "../../../../src/utils/ios-cmdline-tools/SimCtlClient";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { createFakeAndroidEmulator } from "../../../fakes/FakeAndroidEmulator";
import { FakeSimctl } from "../../../fakes/FakeSimctl";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { warmedTests } from "../../../helpers/warmedTests";

/**
 * Hunt (#12123): total-resource admission lists BOTH platforms' inventories (to count `amslot-`
 * orphans) and treats either one failing as "usage unknown". On a host that does not have the
 * Android emulator installed (an iOS-only macOS build host), `emulator -list-avds` fails on every
 * call, so every fresh iOS creation is refused `discovery_incomplete` for as long as
 * AUTOMOBILE_MANAGED_SLOT_MAX_DEVICES is set. Without the limit the same creation only reads the
 * requested platform's inventory and succeeds. The iOS side already answers "no simulators" for a
 * host without Xcode tools (`canDiscoverIosLocally`), so only one direction is permanent.
 */
describe("hunt: total-resource admission on a host without the Android emulator", () => {
  let db: Kysely<BindingRegistryDatabase>;
  let registry: SqliteBindingRegistry;
  let timer: FakeTimer;
  let closeDatabase: (() => Promise<void>) | undefined;

  const reset = async () => {
    await closeDatabase?.();
    timer = new FakeTimer();
    timer.setCurrentTime(1_000);
    db = new Kysely<BindingRegistryDatabase>({
      dialect: new BunSqliteDialect({ database: new Database(":memory:") }),
    });
    closeDatabase = () => db.destroy();
    await migrateBindingRegistry(db, ":memory:");
    registry = new SqliteBindingRegistry(db, { timer, isExecOwnerLive: () => false });
  };
  const warmTest = warmedTests(reset);
  afterAll(async () => {
    await closeDatabase?.();
  });

  /** The daemon's real inventory port over a device manager whose emulator binary is missing. */
  function inventoryOnHostWithoutAndroidEmulator(): DeviceManagerBindingInventory {
    // What AndroidEmulatorClient.listAvds answers when the SDK has no emulator binary (the real
    // client's rejection is pinned by
    // test/utils/android-cmdline-tools/AndroidEmulatorClient-listAvds.test.ts); no emulator can
    // be booted on such a host either.
    const emulator = createFakeAndroidEmulator({
      listAvds: async () => {
        throw new AndroidEmulatorUnavailableError("Android emulator not found.");
      },
      getBootedDevicesChecked: async () => [],
    });
    const simctl = new FakeSimctl();
    return new DeviceManagerBindingInventory(
      new MultiPlatformDeviceManager(
        new FakeAdbExecutor(),
        simctl as unknown as SimCtlClient,
        emulator,
      ),
    );
  }

  warmTest(
    "an iOS creation under the limit is admitted when the host has no Android emulator",
    async () => {
      const inventory = inventoryOnHostWithoutAndroidEmulator();
      // The registry is empty and nothing is listed: usage is this request alone.
      expect((await inventory.list("ios", {})).complete).toBe(true);

      const budget = new RegistryBindingResourceBudget({
        registry: async () => registry,
        policy: { limit: () => 4 },
        inventory,
        timer,
      });
      const admission = await budget.admitCreation({ journalEntryId: 1 });

      // The reconciler turns `unknown` into a retryable `discovery_incomplete` refusal
      // (reconciler.ts admitFreshCreation); retrying can never succeed on this host.
      expect(admission).toMatchObject({ kind: "admitted", enforced: true, limit: 4 });
    },
  );

  function hostInventory(platform: "android" | "ios", failure: Error, available: boolean) {
    const emulator = createFakeAndroidEmulator({
      listAvds: async () => {
        if (platform === "android") {
          throw failure;
        }
        return [];
      },
      getBootedDevicesChecked: async () => [],
    });
    const simctl = new FakeSimctl();
    simctl.setIsAvailable(available);
    simctl.listSimulatorImages = async () => {
      if (platform === "ios") {
        throw failure;
      }
      return [];
    };
    return new DeviceManagerBindingInventory(
      new MultiPlatformDeviceManager(
        new FakeAdbExecutor(),
        simctl as unknown as SimCtlClient,
        emulator,
      ),
    );
  }

  warmTest("an Android creation is admitted without installed simulator tools", async () => {
    // macOS exercises SimctlUnavailableError; other hosts skip listing after isAvailable is false.
    const budget = new RegistryBindingResourceBudget({
      registry: async () => registry,
      policy: { limit: () => 4 },
      timer,
      inventory: hostInventory("ios", new SimctlUnavailableError("simctl unavailable"), false),
    });
    expect(await budget.admitCreation({ journalEntryId: 1 })).toMatchObject({ kind: "admitted" });
  });

  for (const platform of ["android", "ios"] as const) {
    warmTest(
      `${platform} installed-toolchain listing failure keeps admission unknown`,
      async () => {
        const budget = new RegistryBindingResourceBudget({
          registry: async () => registry,
          policy: { limit: () => 4 },
          timer,
          inventory: hostInventory(platform, new ActionableError("listing timeout"), true),
        });
        expect(await budget.admitCreation({ journalEntryId: 1 })).toMatchObject({
          kind: "unknown",
        });
      },
    );
  }
});
