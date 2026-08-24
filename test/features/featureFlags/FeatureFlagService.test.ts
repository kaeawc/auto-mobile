import { describe, expect, test } from "bun:test";
import type { Database as BunDatabase } from "bun:sqlite";
import { Kysely } from "kysely";
import { BunSqliteDialect } from "../../../src/db/bunSqliteDialect";
import type { Database } from "../../../src/db/types";
import { FeatureFlagService } from "../../../src/features/featureFlags/FeatureFlagService";
import type { FeatureFlagDefinition } from "../../../src/features/featureFlags/FeatureFlagDefinitions";
import { SqliteFeatureFlagRepository } from "../../../src/features/featureFlags/FeatureFlagRepository";
import { fixedBackoff } from "../../../src/utils/Backoff";
import type { Random } from "../../../src/utils/Random";
import { FakeFeatureFlagRepository } from "../../fakes/FakeFeatureFlagRepository";
import { FakeFeatureFlagApplier } from "../../fakes/FakeFeatureFlagApplier";
import { FakeTimer } from "../../fakes/FakeTimer";

const TEST_DEFINITIONS: FeatureFlagDefinition[] = [
  {
    key: "debug",
    label: "Debug mode",
    description: "debug",
    defaultValue: false,
  },
  {
    key: "ui-perf-mode",
    label: "UI perf mode",
    description: "ui perf",
    defaultValue: true,
  },
];

class FakeSqliteError extends Error {
  constructor(
    message: string,
    readonly code: string,
  ) {
    super(message);
    this.name = "SQLiteError";
  }
}

const zeroRandom: Random = {
  next: () => 0,
  pick: <T>(items: readonly T[]): T => items[0]!,
};

function createContendedFeatureFlagDatabase(definitions: FeatureFlagDefinition[]): {
  db: BunDatabase;
  insertAttempts: () => number;
} {
  let inserts = 0;
  const db = {
    prepare: (sql: string) => ({
      all: (..._params: unknown[]) => {
        if (sql.toLowerCase().startsWith("select")) {
          return definitions.map((definition) => ({
            key: definition.key,
            enabled: definition.defaultValue ? 1 : 0,
            config_json: definition.defaultConfig ? JSON.stringify(definition.defaultConfig) : null,
            updated_at: "2026-08-24T00:00:00.000Z",
          }));
        }
        return [];
      },
      run: (..._params: unknown[]) => {
        inserts += 1;
        if (inserts === 1) {
          throw new FakeSqliteError("database is locked", "SQLITE_BUSY");
        }
        return { changes: definitions.length, lastInsertRowid: 1 };
      },
      get: (..._params: unknown[]) => ({ schema_version: 0 }),
      finalize: () => {},
    }),
    exec: (_sql: string) => {},
    close: () => {},
  } as BunDatabase;

  return { db, insertAttempts: () => inserts };
}

describe("FeatureFlagService", () => {
  test("initializes defaults and applies them", async () => {
    const repository = new FakeFeatureFlagRepository();
    const applier = new FakeFeatureFlagApplier();
    const service = new FeatureFlagService(repository, applier, TEST_DEFINITIONS);

    const flags = await service.listFlags();

    expect(flags).toHaveLength(2);
    expect(flags.find((flag) => flag.key === "debug")?.enabled).toBe(false);
    expect(flags.find((flag) => flag.key === "ui-perf-mode")?.enabled).toBe(true);
    expect(applier.applied).toContainEqual({ key: "debug", enabled: false, config: null });
    expect(applier.applied).toContainEqual({ key: "ui-perf-mode", enabled: true, config: null });
  });

  test("retries a contended initial feature-flag insert", async () => {
    const timer = new FakeTimer();
    timer.enableAutoAdvance();
    const { db: connection, insertAttempts } = createContendedFeatureFlagDatabase(TEST_DEFINITIONS);
    const database = new Kysely<Database>({
      dialect: new BunSqliteDialect({
        database: connection,
        retry: {
          maxAttempts: 3,
          backoff: fixedBackoff(10),
          timer,
          random: zeroRandom,
        },
      }),
    });
    const applier = new FakeFeatureFlagApplier();
    const service = new FeatureFlagService(
      new SqliteFeatureFlagRepository(database),
      applier,
      TEST_DEFINITIONS,
    );

    try {
      const flags = await service.listFlags();

      expect(flags.map((flag) => [flag.key, flag.enabled])).toEqual([
        ["debug", false],
        ["ui-perf-mode", true],
      ]);
      expect(applier.applied).toHaveLength(TEST_DEFINITIONS.length);
      expect(insertAttempts()).toBe(2);
      expect(timer.getSleepHistory()).toHaveLength(1);
    } finally {
      await database.destroy();
    }
  });

  test("updates flags and reapplies", async () => {
    const repository = new FakeFeatureFlagRepository();
    const applier = new FakeFeatureFlagApplier();
    const service = new FeatureFlagService(repository, applier, TEST_DEFINITIONS);

    const updated = await service.setFlag("debug", true);

    expect(updated.enabled).toBe(true);
    expect(applier.applied[applier.applied.length - 1]).toEqual({
      key: "debug",
      enabled: true,
      config: null,
    });
  });
});
