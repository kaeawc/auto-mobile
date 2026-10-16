import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { SessionBroker } from "../../../src/daemon/sessionBroker/broker";
import { ManagedDevicePort } from "../../../src/daemon/sessionBroker/managedDevicePort";
import { BrokerDeviceAcquisition } from "../../../src/daemon/sessionBroker/provisioning/deviceAcquisition";
import { WorkflowBindingDeviceDeleter } from "../../../src/daemon/sessionBroker/provisioning/deviceDeleter";
import {
  BindingReconciler,
  DefaultManagedSpecResolver,
} from "../../../src/daemon/sessionBroker/provisioning/reconciler";
import { BindingJournal } from "../../../src/daemon/sessionBroker/registry/bindingJournal";
import { BINDING_REGISTRY_MIGRATIONS } from "../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import {
  SqliteBindingRegistry,
  type BindingRegistryDatabase,
} from "../../../src/daemon/sessionBroker/registry/sqliteBindingRegistry";
import type { TeardownDeviceArgs } from "../../../src/server/deviceTools";
import type { SessionConfig } from "../../../src/devices/sessionConfig";
import type { Kysely } from "kysely";
import { CountingIdGenerator } from "../../../src/utils/IdGenerator";
import { createTestDatabase } from "../../db/testDbHelper";
import { FakeTimer } from "../../fakes/FakeTimer";
import {
  androidCatalog,
  androidDefaults,
  iosCatalog,
  iosDefaults,
} from "../../devices/sessionRequirements/fixtures";
import {
  FakeCapacity,
  FakeClaims,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "./registry/fixtures/reconcilerFakes";

const SCOPE = { managedHostScope: "host", runnerNamespace: "broker", runnerIncarnation: "stable" };
const OWNER = { daemonId: "upgrade-test", pid: 1, processGenerationToken: "fake" };
type Platform = "ios" | "android";
const config = (requestId: string, platform: Platform): SessionConfig => ({
  contractVersion: 1,
  requestId,
  device: { schemaVersion: 1, platform, hardware: { kind: "omitted" }, os: { kind: "omitted" } },
});

describe("legacy product inventory through broker lifecycle", () => {
  let registry: SqliteBindingRegistry;
  let timer: FakeTimer;
  let inventory: FakeInventory;
  let provisioner: FakeProvisioner;
  let acquisition: BrokerDeviceAcquisition;
  let broker: SessionBroker;
  let port: ManagedDevicePort;
  let scopeKey: string;
  let deletions: TeardownDeviceArgs[];
  let releases: string[];

  const databases: Kysely<BindingRegistryDatabase>[] = [];
  beforeAll(async () => {
    // Prepare one independent clone per case outside the 15ms lifecycle budget.
    for (let index = 0; index < 3; index++) {
      const db = await createTestDatabase();
      for (const migration of Object.values(BINDING_REGISTRY_MIGRATIONS)) {
        await migration.up(db);
      }
      databases.push(db.withTables<BindingRegistryDatabase>());
    }
  });

  beforeEach(async () => {
    const db = databases.shift();
    if (!db) {
      throw new Error("missing test database");
    }
    timer = new FakeTimer();
    registry = new SqliteBindingRegistry(db, {
      timer,
      isExecOwnerLive: () => true,
    });
    const scope = await registry.ensureScope(SCOPE);
    if (scope.kind !== "ready") {
      throw new Error("scope setup failed");
    }
    scopeKey = scope.scope.scopeKey;
    inventory = new FakeInventory();
    provisioner = new FakeProvisioner(inventory);
    const matcher = new FakeMatcher();
    const claims = new FakeClaims();
    deletions = [];
    releases = [];
    const deleter = new WorkflowBindingDeviceDeleter(timer, () => async (args) => {
      deletions.push(args);
      inventory.remove(args.target.stableId);
      return { content: [{ type: "text", text: JSON.stringify({ state: "destroyed" }) }] };
    });
    const journal = new BindingJournal({
      registry,
      inventory,
      matcher,
      deleter,
      claims,
      timer,
      owner: OWNER,
      isOwnerLive: () => false,
      isExecOwnerLive: () => true,
    });
    const reconciler = new BindingReconciler({
      registry,
      inventory,
      matcher,
      provisioner,
      deleter,
      claims,
      timer,
      resolver: new DefaultManagedSpecResolver(),
      capacity: new FakeCapacity(),
      idGenerator: new CountingIdGenerator("nonce"),
      isExecOwnerLive: () => true,
    });
    acquisition = new BrokerDeviceAcquisition({
      registry: async () => registry,
      reconcile: (_, request) => reconciler.reconcile(request),
      owner: () => OWNER,
      timer,
      sessions: {
        claimLivenessOwnership: async () => "claimed",
        adoptManagedExecutionLivenessPolicy: async () => {},
        releaseSession: (id) => provisioner.releaseSession(id),
      },
    });
    port = new ManagedDevicePort({
      scope: SCOPE,
      registry,
      bindingJournal: journal,
      brokerDeviceAcquisition: acquisition,
      brokerExecutionRelease: {
        releaseExecution: async (sessionId) => {
          releases.push(sessionId);
          for (const assignment of await registry.findExecutionAssignments(sessionId)) {
            await registry.releaseExecution(assignment, sessionId);
          }
          return {
            sessionId,
            outcome: "reusable_for_this_binding",
            settlement: "confirmed",
            alreadyReleased: false,
            cancellationRequested: 0,
            releaseForced: false,
            device: null,
            bindings: [],
            bindingFailures: [],
          };
        },
      },
      // Fake native reset permits exercising the real broker cache eviction policy.
      resetIosBaseline: async (_, __, assertOwned) => {
        await assertOwned();
        return "clean";
      },
      isCurrentReset: async () => true,
    });
    broker = new SessionBroker({
      store: registry.sessionBrokerStore(scopeKey, new CountingIdGenerator("resource")),
      devices: port,
      owner: OWNER,
      limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 1 },
      catalog: async (platform) => (platform === "ios" ? iosCatalog() : androidCatalog()),
      defaults: (platform) => (platform === "ios" ? iosDefaults() : androidDefaults()),
    });
  });

  afterEach(async () => {
    await broker.close();
    await acquisition.close();
    await registry.close();
    timer.reset();
  });

  function legacyDevice(platform: Platform) {
    // The first durable broker allocation has index 1. Model a pre-upgrade interrupted create.
    const name = `amslot-${scopeKey.slice(0, 8)}-1-g1-upgrade`;
    inventory.devices.push({
      platform,
      name,
      isRunning: false,
      ...(platform === "ios"
        ? {
            deviceId: "SIM-UPGRADE",
            runtime: "com.apple.CoreSimulator.SimRuntime.iOS-27-0",
            deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro-Max",
          }
        : {
            runtime: "system-images;android-35;google_apis;arm64-v8a",
            deviceType: "pixel_phone",
          }),
    });
    return name;
  }

  test.each(["ios", "android"] as const)(
    "legacy %s leftover is reconciled, released and destroyed through the native journal",
    async (platform) => {
      const name = legacyDevice(platform);
      const result = await broker.prepare(config("upgrade", platform), "consumer");
      expect(result.outcome).toBe("ready");
      expect(provisioner.calls).toMatchObject([{ mode: "adopt", name }]);
      expect(await broker.release(result.sessionUuid!)).toMatchObject({ outcome: "released" });
      expect(releases).toContain(result.sessionUuid!);
      expect(deletions).toMatchObject([
        {
          target: { platform, stableName: name },
          mode: "destroy",
          verifyAbsence: true,
        },
      ]);
      expect(inventory.devices).toEqual([]);
      expect(await registry.getAssignment({ scopeKey, bindingIndex: 1 })).toMatchObject({
        stableDeviceId: null,
        execOwner: null,
      });
    },
  );

  test("cache eviction destroys a legacy simulator before creating a new broker AVD", async () => {
    const name = legacyDevice("ios");
    // Enable qualified reuse with a fake baseline, then request an incompatible platform.
    const store = registry.sessionBrokerStore(scopeKey, new CountingIdGenerator("cache-resource"));
    const cachedBroker = new SessionBroker({
      store,
      devices: port,
      owner: OWNER,
      reuseCleanDevices: true,
      limits: { totalDeviceCap: 1, sessionCap: 1, idlePoolCap: 1 },
      catalog: async (platform) => (platform === "ios" ? iosCatalog() : androidCatalog()),
      defaults: (platform) => (platform === "ios" ? iosDefaults() : androidDefaults()),
    });
    try {
      const first = await cachedBroker.prepare(config("cached", "ios"), "consumer");
      expect(first.outcome).toBe("ready");
      expect(await cachedBroker.release(first.sessionUuid!)).toMatchObject({ outcome: "released" });
      expect((await store.listResources())[0].state).toBe("idle");
      expect(deletions).toEqual([]);
      const second = await cachedBroker.prepare(config("replacement", "android"), "consumer");
      expect(second.outcome).toBe("ready");
      expect(deletions).toMatchObject([
        { target: { stableName: name }, mode: "destroy", verifyAbsence: true },
      ]);
      expect(provisioner.created()).toMatchObject([
        { platform: "android", name: expect.stringContaining("ambroker-") },
      ]);
      expect((await store.listResources())[0].state).toBe("destroyed");
      await cachedBroker.release(second.sessionUuid!);
    } finally {
      await cachedBroker.close();
    }
  });
});
