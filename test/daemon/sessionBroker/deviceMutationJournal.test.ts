import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { Kysely } from "kysely";
import { Database as BunDatabase } from "bun:sqlite";
import { BunSqliteDialect } from "../../../src/db/bunSqliteDialect";
import { BINDING_REGISTRY_MIGRATIONS } from "../../../src/daemon/sessionBroker/registry/bindingRegistryMigrations";
import * as migration from "../../../src/daemon/sessionBroker/registry/migrations/2026_10_21_012_device_mutation_journal";
import {
  SqliteDeviceMutationJournal,
  type DeviceMutationTables,
} from "../../../src/daemon/sessionBroker/mutations/sqliteJournal";
import {
  applyJournaledMutation,
  type DeviceBaseline,
  type DeviceMutationInput,
} from "../../../src/daemon/sessionBroker/mutations/types";
import { createTestBunDatabase, createTestDatabase } from "../../db/testDbHelper";
import { FakeTimer } from "../../fakes/FakeTimer";

const SCOPE = { sessionUuid: "session-a", deviceId: "phone", incarnation: "binding-generation-1" };
const MUTATION: DeviceMutationInput = {
  kind: "device-setting",
  key: "locale",
  priorValue: { state: "present", value: "en-US" },
  toolName: "changeLocalization",
};
const BASELINE: DeviceBaseline = {
  completeKinds: [],
  observations: [],
  unobservable: ["keychain"],
};

describe("durable device mutation journal", () => {
  let db: Kysely<DeviceMutationTables>;
  let journal: SqliteDeviceMutationJournal;
  const timer = new FakeTimer();

  beforeAll(async () => {
    db = (await createTestDatabase()).withTables<{
      [Table in keyof DeviceMutationTables]: DeviceMutationTables[Table];
    }>();
    await migration.up(db as Kysely<unknown>);
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    timer.reset();
    await db.deleteFrom("device_mutation_journal").execute();
    await db.deleteFrom("device_mutation_baselines").execute();
    journal = new SqliteDeviceMutationJournal(db, timer);
  });

  test("migration belongs to the host broker registry", () => {
    expect(BINDING_REGISTRY_MIGRATIONS["2026_10_21_012_device_mutation_journal"]).toBe(migration);
  });

  test("first write wins and reverse replay has a durable sequence even at equal timestamps", async () => {
    await journal.record(SCOPE, MUTATION);
    await journal.record(SCOPE, { ...MUTATION, priorValue: { state: "present", value: "fr-FR" } });
    await journal.record(SCOPE, { ...MUTATION, key: "nightMode", priorValue: { state: "absent" } });
    const entries = await journal.list(SCOPE);
    expect(entries).toHaveLength(2);
    expect(entries[0].priorValue).toEqual(MUTATION.priorValue);
    expect(entries[0].appliedAt).toBe(entries[1].appliedAt);
    expect(entries[0].sequence).toBeLessThan(entries[1].sequence);
  });

  test("recreating the repository recovers entries and the first pool baseline from SQLite", async () => {
    await journal.record(SCOPE, MUTATION);
    await journal.captureBaseline(SCOPE, BASELINE);
    await journal.captureBaseline(SCOPE, { ...BASELINE, unobservable: [] });
    const reopened = new SqliteDeviceMutationJournal(db, new FakeTimer());
    expect(await reopened.list(SCOPE)).toHaveLength(1);
    expect(await reopened.getBaseline(SCOPE)).toEqual(BASELINE);
  });

  test("closing the SQLite connection and reopening its persisted bytes recovers interrupted reset intent", async () => {
    const handle = await createTestBunDatabase();
    const first = new Kysely<DeviceMutationTables>({
      dialect: new BunSqliteDialect({ database: handle }),
    });
    let bytes: Uint8Array;
    try {
      await migration.up(first as Kysely<unknown>);
      const initial = new SqliteDeviceMutationJournal(first, timer);
      await initial.record(SCOPE, MUTATION);
      await initial.captureBaseline(SCOPE, BASELINE);
      bytes = handle.serialize();
    } finally {
      await first.destroy();
    }
    const reopened = new Kysely<DeviceMutationTables>({
      dialect: new BunSqliteDialect({ database: BunDatabase.deserialize(bytes) }),
    });
    try {
      const recovered = new SqliteDeviceMutationJournal(reopened, timer);
      expect(await recovered.list(SCOPE)).toHaveLength(1);
      expect(await recovered.getBaseline(SCOPE)).toEqual(BASELINE);
      expect(await recovered.list({ ...SCOPE, incarnation: "replacement" })).toEqual([]);
    } finally {
      await reopened.destroy();
    }
  });

  test("a replacement incarnation and another device or session never inherit entries", async () => {
    await journal.record(SCOPE, MUTATION);
    await journal.captureBaseline(SCOPE, BASELINE);
    for (const scope of [
      { ...SCOPE, incarnation: "binding-generation-2" },
      { ...SCOPE, deviceId: "other-phone" },
      { ...SCOPE, sessionUuid: "other-session" },
    ]) {
      expect(await journal.list(scope)).toEqual([]);
    }
    expect(await journal.getBaseline({ ...SCOPE, incarnation: "binding-generation-2" })).toBeNull();
    expect(await journal.getBaseline(SCOPE)).toEqual(BASELINE);
  });

  test("null, literal absent, and missing values remain distinct", async () => {
    for (const [key, priorValue] of [
      ["null", { state: "present", value: null }],
      ["literal", { state: "present", value: "absent" }],
      ["missing", { state: "absent" }],
    ] as const) {
      await journal.record(SCOPE, { ...MUTATION, key, priorValue });
    }
    expect((await journal.list(SCOPE)).map((entry) => entry.priorValue)).toEqual([
      { state: "present", value: null },
      { state: "present", value: "absent" },
      { state: "absent" },
    ]);
  });

  test("record-before-act commits intent even when the mutation fails", async () => {
    const error = new Error("device write failed");
    await expect(
      applyJournaledMutation(journal, SCOPE, MUTATION, async () => {
        expect(await journal.list(SCOPE)).toHaveLength(1);
        throw error;
      }),
    ).rejects.toThrow(error);
    expect(await journal.list(SCOPE)).toHaveLength(1);
  });

  test("failed persistence prevents the device action", async () => {
    let acted = false;
    await expect(
      applyJournaledMutation(journal, { ...SCOPE, incarnation: "" }, MUTATION, async () => {
        acted = true;
      }),
    ).rejects.toThrow("non-empty identity");
    expect(acted).toBe(false);
  });

  test("completed-session cleanup is exact and keeps the incarnation baseline", async () => {
    const other = { ...SCOPE, sessionUuid: "session-b" };
    await journal.record(SCOPE, MUTATION);
    await journal.record(other, MUTATION);
    await journal.captureBaseline(SCOPE, BASELINE);
    await journal.deleteSession(SCOPE);
    expect(await journal.list(SCOPE)).toEqual([]);
    expect(await journal.list(other)).toHaveLength(1);
    expect(await journal.getBaseline(SCOPE)).toEqual(BASELINE);
  });
});
