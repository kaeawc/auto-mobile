import { beforeAll, describe, expect, test } from "bun:test";
import { Database as Sqlite } from "bun:sqlite";
import { readFileSync } from "node:fs";
import { Kysely, sql } from "kysely";
import { BunSqliteDialect } from "../../src/db/bunSqliteDialect";
import { DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD } from "../../src/daemon/constants";
import { DaemonHandshakeMismatchError } from "../../src/daemon/client";
import {
  DAEMON_CAPABILITIES_METHOD,
  handleDaemonRequest,
  type DaemonStateAccess,
} from "../../src/daemon/daemonRequestHandlers";
import {
  acquireManagedSlotsThroughDaemon,
  type ManagedSlotProxyAcquisitionPorts,
} from "../../src/daemon/managedSlotProxyAcquisition";
import {
  migrateSlotRegistry,
  SLOT_REGISTRY_MIGRATIONS,
} from "../../src/daemon/managedSlots/slotRegistryMigrations";
import type { SlotRegistryDatabase } from "../../src/daemon/managedSlots/sqliteSlotRegistry";
import { ManagedSlotRegistrySchemaUnsupportedError } from "../../src/daemon/managedSlots/managedSlotRefusal";
import {
  MANAGED_SLOT_CONFIG_ENV,
  MANAGED_SLOT_CONFIG_FLAG,
  MANAGED_SLOT_SUPPORTED_CONTRACT_VERSIONS,
  MANAGED_SLOTS_EXPERIMENTAL_CAPABILITY,
  MANAGED_SLOTS_V1_CAPABILITY,
  MANAGED_SLOTS_V1_DEVICE_FAMILY_CAPABILITY,
  MAX_MANAGED_SLOT_GROUP_SIZE,
  ManagedSlotConfigError,
  daemonSupportsManagedSlots,
  parseManagedSlotConfig,
  unmetManagedSlotConfigCapabilities,
  type ManagedSlotConfig,
  type ManagedSlotConfigErrorCode,
} from "../../src/models/managedSlotConfig";
import { FakeTimer } from "../fakes/FakeTimer";
import { readyManagedSlotsResult } from "../helpers/refusalWireFixtures";

// Read once outside per-test timing; use the JSON's own rows as the executable table.
const contract: typeof import("../../schemas/managed-slot-contract.json") = JSON.parse(
  readFileSync(new URL("../../schemas/managed-slot-contract.json", import.meta.url), "utf8"),
);
const configErrorCodes = {
  managed_slot_config_invalid: true,
  contract_unsupported: true,
  managed_slot_group_unsupported: true,
  managed_slots_unsupported: true,
} satisfies Record<ManagedSlotConfigErrorCode, true>;

function configFor(frontend: NonNullable<(typeof contract.compatibility)[number]["frontend"]>) {
  return {
    contractVersion: frontend.contractVersion,
    managedHostScope: "host",
    runnerNamespace: "runner",
    runnerIncarnation: "incarnation",
    localSlotCapacity: frontend.groupSize,
    preparationTimeoutMs: 100,
    requests: Array.from({ length: frontend.groupSize }, (_, slotIndex) => ({
      slotIndex,
      role: `app-${slotIndex}`,
      platform: "ios",
      requestedSpec: {
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
        ...(frontend.usesDeviceFamily ? { deviceFamily: "phone" } : {}),
      },
    })),
  };
}

// No initialized subsystem may be touched by the self-description probe.
const uninitializedState: DaemonStateAccess = {
  isInitialized: () => false,
  getSessionManager: () => {
    throw new Error("Daemon not initialized");
  },
  getDevicePool: () => {
    throw new Error("Daemon not initialized");
  },
  getDeviceSessionRegistry: () => {
    throw new Error("Daemon not initialized");
  },
};

describe("published managed-slot contract", () => {
  let migratedRegistryTemplate: Uint8Array;

  // Build immutable schema bytes once, as in test/db/videoRecordingRecorderDaemonScope.test.ts.
  // The gap test clones them so its budget measures the newer-registry probe, not schema setup.
  beforeAll(async () => {
    const database = new Sqlite(":memory:");
    const db = new Kysely<SlotRegistryDatabase>({
      dialect: new BunSqliteDialect({ database }),
    });
    try {
      await migrateSlotRegistry(db, ":memory:");
      migratedRegistryTemplate = database.serialize();
    } finally {
      await db.destroy();
    }
  });

  test("constants and ordered migrations match the published contract", () => {
    expect(contract.contractFileVersion).toBe(1);
    expect(contract.contractVersions).toEqual(MANAGED_SLOT_SUPPORTED_CONTRACT_VERSIONS);
    expect(contract.launchConfig).toEqual({
      flag: MANAGED_SLOT_CONFIG_FLAG,
      env: MANAGED_SLOT_CONFIG_ENV,
    });
    expect(contract.capabilityProbeMethod).toBe(DAEMON_CAPABILITIES_METHOD);
    expect(contract.acquireMethod).toBe(DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD);
    expect(contract.initializeExperimentalKey).toBe(MANAGED_SLOTS_EXPERIMENTAL_CAPABILITY);
    expect(contract.daemonCapabilities.base).toBe(MANAGED_SLOTS_V1_CAPABILITY);
    expect(contract.daemonCapabilities.additive.map((entry) => entry.capability)).toEqual([
      MANAGED_SLOTS_V1_DEVICE_FAMILY_CAPABILITY,
    ]);
    expect(contract.maxGroupSize).toBe(MAX_MANAGED_SLOT_GROUP_SIZE);
    expect([...contract.configErrorCodes].sort()).toEqual(Object.keys(configErrorCodes).sort());
    expect(contract.registry.migrations).toEqual(Object.keys(SLOT_REGISTRY_MIGRATIONS));
  });

  test("daemon advertisement and additive config fields match the published contract", async () => {
    const response = await handleDaemonRequest(
      {
        id: "contract",
        type: "daemon_request",
        method: contract.capabilityProbeMethod,
        params: {},
      },
      uninitializedState,
    );
    expect(response.success).toBe(true);
    const result = response.result as { capabilities: string[] };
    expect(result.capabilities.filter((entry) => entry.startsWith("managed-slots/"))).toEqual([
      contract.daemonCapabilities.base,
      ...contract.daemonCapabilities.additive.map((entry) => entry.capability),
    ]);
    const config = parseManagedSlotConfig(
      configFor({ contractVersion: 1, groupSize: 1, usesDeviceFamily: true }),
    );
    expect(
      unmetManagedSlotConfigCapabilities(config, [contract.daemonCapabilities.base]).map(
        (entry) => ({
          capability: entry.capability,
          configField: entry.field.replace("requests.0.", "requests[]."),
        }),
      ),
    ).toEqual(contract.daemonCapabilities.additive);
    expect(unmetManagedSlotConfigCapabilities(config, result.capabilities)).toEqual([]);
  });

  test("rows have unique ids and descriptions, with native qualification explicitly owed", () => {
    expect(new Set(contract.compatibility.map((row) => row.id)).size).toBe(
      contract.compatibility.length,
    );
    for (const row of contract.compatibility) {
      expect(row.id).toMatch(/^[a-z0-9]+(?:-[a-z0-9]+)*$/);
      expect(row.description.trim().length).toBeGreaterThan(0);
      expect(["unit-test", "native-qualification"]).toContain(row.verifiedBy);
      expect(row.supported).toBe(row.outcome === "acquire" || row.outcome === "unmanaged");
      expect(row.refusedBeforeMutation).toBe(!row.supported);
    }
    expect(
      contract.compatibility.filter((row) => row.verifiedBy === "native-qualification"),
    ).toEqual([
      expect.objectContaining({
        id: "unmanaged-frontend-shares-daemon",
        frontend: null,
        supported: true,
        outcome: "unmanaged",
        refusedBeforeMutation: false,
      }),
    ]);
  });

  test.each(contract.compatibility.filter((row) => row.verifiedBy === "unit-test"))(
    "compatibility: $id",
    async (row) => {
      expect(row.frontend).not.toBeNull();
      if (row.frontend === null) {
        throw new Error("Unit-test rows require a managed frontend");
      }
      const calls: string[] = [];
      const held: string[] = [];
      const tracked: string[][] = [];
      let releases = 0;
      const ports: ManagedSlotProxyAcquisitionPorts = {
        timer: new FakeTimer(),
        livenessOwnerToken: "contract-owner",
        ensureConnected: async () => {
          if ("daemonConnect" in row && row.daemonConnect === "handshake-mismatch") {
            throw new DaemonHandshakeMismatchError(
              {
                code: "daemon_identity_mismatch",
                phase: "daemon-preflight",
                executionStarted: false,
                reason: "version",
                daemon: { version: "0.0.68", build: { buildId: "old", entryScript: "/old" } },
                client: {
                  clientVersion: "0.0.70",
                  clientBuildId: "new",
                  clientEntryScript: "/new",
                },
              },
              "daemon version mismatch",
            );
          }
        },
        callDaemonMethod: async (method) => {
          calls.push(method);
          if (method === DAEMON_CAPABILITIES_METHOD) {
            return { capabilities: row.daemonCapabilities };
          }
          expect(method).toBe(DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD);
          return readyManagedSlotsResult("contract-session");
        },
        trackAcquiredSessions: (ids) => {
          tracked.push([...ids]);
        },
        holdSession: async (id) => {
          held.push(id);
        },
        releaseHeldSessions: async () => {
          releases++;
        },
      };
      let config: ManagedSlotConfig;
      try {
        config = parseManagedSlotConfig(configFor(row.frontend));
      } catch (error) {
        // Parsing refusals are expected for unsupported versions/groups; assert their typed code.
        expect(error).toBeInstanceOf(ManagedSlotConfigError);
        if (!(error instanceof ManagedSlotConfigError)) {
          throw error;
        }
        expect(error.code).toBe(row.outcome);
        expect(row.supported).toBe(false);
        expect(row.refusedBeforeMutation).toBe(true);
        expect(calls).toEqual([]);
        return;
      }
      expect(daemonSupportsManagedSlots(row.daemonCapabilities)).toBe(
        row.daemonCapabilities.includes(contract.daemonCapabilities.base),
      );
      const result = await acquireManagedSlotsThroughDaemon(config, ports);
      if (row.outcome === "acquire") {
        expect(result.outcome).toBe("ready");
        expect(calls).toEqual([DAEMON_CAPABILITIES_METHOD, DAEMON_ACQUIRE_MANAGED_SLOTS_METHOD]);
        expect(tracked).toEqual([["contract-session"]]);
        expect(held).toEqual(["contract-session"]);
      } else {
        expect(result.outcome).toBe("failed");
        expect(result.failure).toMatchObject({ code: row.outcome, retryable: false });
      }
      if (row.refusedBeforeMutation) {
        expect(calls).toEqual(
          "daemonConnect" in row && row.daemonConnect === "handshake-mismatch"
            ? []
            : [DAEMON_CAPABILITIES_METHOD],
        );
        expect(tracked).toEqual([]);
        expect(held).toEqual([]);
        expect(releases).toBe(0);
      }
    },
  );

  test("older builds on newer registries are refused before mutation as published", async () => {
    const db = new Kysely<SlotRegistryDatabase>({
      dialect: new BunSqliteDialect({
        database: new Sqlite(new Uint8Array(migratedRegistryTemplate)),
      }),
    });
    try {
      await migrateSlotRegistry(db, ":memory:");
      await sql`INSERT INTO kysely_migration (name, timestamp) VALUES ('2099_01_01_999_future', '2099-01-01T00:00:00.000Z')`.execute(
        db,
      );
      const migration = migrateSlotRegistry(db, ":memory:");
      const message =
        "Update registry.olderBuildOnNewerRegistry in schemas/managed-slot-contract.json when the refusal behavior changes";
      if (contract.registry.olderBuildOnNewerRegistry.refusedBeforeMutation) {
        await expect(migration, message).rejects.toBeInstanceOf(
          ManagedSlotRegistrySchemaUnsupportedError,
        );
        try {
          await migration;
        } catch (error) {
          expect(error).toBeInstanceOf(ManagedSlotRegistrySchemaUnsupportedError);
          if (!(error instanceof ManagedSlotRegistrySchemaUnsupportedError)) {
            throw error;
          }
          expect(error.code).toBe(contract.registry.olderBuildOnNewerRegistry.failureCode);
          expect(error.retryable).toBe(contract.registry.olderBuildOnNewerRegistry.retryable);
          expect(error.unknownMigrations).toEqual(["2099_01_01_999_future"]);
        }
        const rows = await db.selectFrom("kysely_migration").select("name").execute();
        expect(rows.filter((row) => row.name.includes("future")).map((row) => row.name)).toEqual([
          "2099_01_01_999_future",
        ]);
      } else {
        await expect(migration, message).resolves.toBeUndefined();
      }
    } finally {
      await db.destroy();
    }
  });
});
