import { afterEach, describe, expect, test } from "bun:test";
import { sql, type Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { FeatureFlagService } from "../../src/features/featureFlags/FeatureFlagService";
import type { FeatureFlagDefinition } from "../../src/features/featureFlags/FeatureFlagDefinitions";
import { SqliteFeatureFlagRepository } from "../../src/db/featureFlagRepository";
import { FakeFeatureFlagApplier } from "../fakes/FakeFeatureFlagApplier";
import { FakeLogger } from "../fakes/FakeLogger";
import { createTestDatabase } from "./testDbHelper";

const definitions: FeatureFlagDefinition[] = [
  {
    key: "accessibility-audit",
    label: "Accessibility",
    description: "accessibility flag",
    defaultValue: true,
    defaultConfig: { level: "AA" },
  },
];

describe("SqliteFeatureFlagRepository config_json validation (#11859)", () => {
  let db: Kysely<Database> | undefined;

  afterEach(async () => {
    await db?.destroy();
    db = undefined;
  });

  async function storeRawConfig(configJson: string | null): Promise<void> {
    db = await createTestDatabase();
    await sql`INSERT INTO feature_flags (key, enabled, config_json, updated_at)
      VALUES ('accessibility-audit', 1, ${configJson}, '2026-10-01T00:00:00.000Z')`.execute(db);
  }

  test("reads a stored object config unchanged", async () => {
    await storeRawConfig('{"level":"AAA","ignoreRules":["1.4.3"]}');
    const log = new FakeLogger();
    const flags = await new SqliteFeatureFlagRepository({ db, log }).listFlags();

    expect(flags[0]?.config).toEqual({ level: "AAA", ignoreRules: ["1.4.3"] });
    expect(log.at("warn")).toHaveLength(0);
  });

  test.each([
    ["truncated JSON", '{"level":"A'],
    ["legacy bare string", '"AA"'],
    ["array", '["AA"]'],
    ["number", "3"],
    ["JSON null literal", "null"],
  ])("reads %s as null with a warning instead of throwing", async (_name, raw) => {
    await storeRawConfig(raw);
    const log = new FakeLogger();
    const flags = await new SqliteFeatureFlagRepository({ db, log }).listFlags();

    expect(flags).toHaveLength(1);
    expect(flags[0]?.enabled).toBe(true);
    expect(flags[0]?.config).toBeNull();
    expect(log.at("warn")).toHaveLength(1);
  });

  test("a SQL NULL config is null without a warning", async () => {
    await storeRawConfig(null);
    const log = new FakeLogger();
    const flags = await new SqliteFeatureFlagRepository({ db, log }).listFlags();

    expect(flags[0]?.config).toBeNull();
    expect(log.at("warn")).toHaveLength(0);
  });

  test("the service falls back to the definition default config for a corrupt row", async () => {
    await storeRawConfig('{"level":');
    const applier = new FakeFeatureFlagApplier();
    const service = new FeatureFlagService(
      new SqliteFeatureFlagRepository({ db, log: new FakeLogger() }),
      applier,
      definitions,
    );

    const flags = await service.listFlags();

    expect(flags[0]?.config).toEqual({ level: "AA" });
  });
});
