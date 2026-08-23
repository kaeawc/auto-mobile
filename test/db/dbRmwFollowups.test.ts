import { afterEach, describe, expect, test } from "bun:test";
import { sql, type Kysely } from "kysely";
import { BaselineManager } from "../../src/features/accessibility/BaselineManager";
import { SqliteFeatureFlagRepository } from "../../src/features/featureFlags/FeatureFlagRepository";
import type { FeatureFlagDefinition } from "../../src/features/featureFlags/FeatureFlagDefinitions";
import { MemoryBaselineManager } from "../../src/features/memory/MemoryBaselineManager";
import type { MemoryMetrics } from "../../src/features/memory/MemoryMetricsCollector";
import { MemoryThresholdManager } from "../../src/features/memory/MemoryThresholdManager";
import { ThresholdManager } from "../../src/features/performance/ThresholdManager";
import type { DeviceCapabilities } from "../../src/utils/DeviceCapabilities";
import { NavigationRepository } from "../../src/db/navigationRepository";
import { getStorageEvents, recordStorageEvent } from "../../src/db/storageEventRepository";
import type { Database } from "../../src/db/types";
import type { WcagViolation } from "../../src/models/AccessibilityAudit";
import { runConcurrentSameKeyStress } from "./concurrencyStressHelper";
import { createTestDatabase } from "./testDbHelper";

describe("DB RMW follow-up fixes (#3415)", () => {
  const N = 8;
  const openDbs: Kysely<Database>[] = [];

  afterEach(async () => {
    await Promise.all(openDbs.splice(0).map((db) => db.destroy()));
  });

  async function openDb(): Promise<Kysely<Database>> {
    const db = await createTestDatabase();
    openDbs.push(db);
    return db;
  }

  const featureDefinitions: FeatureFlagDefinition[] = [
    {
      key: "debug",
      label: "Debug",
      description: "debug flag",
      defaultValue: false,
    },
    {
      key: "accessibility-audit",
      label: "Accessibility",
      description: "accessibility flag",
      defaultValue: true,
      defaultConfig: { level: "AA" },
    },
  ];

  function violation(fingerprint: string): WcagViolation {
    return {
      type: "missing-content-description",
      severity: "error",
      criterion: "1.1.1",
      message: "Missing content description",
      element: { bounds: { left: 0, top: 0, right: 10, bottom: 10 } },
      fingerprint,
    };
  }

  function memoryMetrics(value: number): MemoryMetrics {
    return {
      preSnapshot: {
        javaHeapMb: value,
        nativeHeapMb: value,
        totalPssMb: value,
        timestamp: 1000,
        raw: "",
      },
      postSnapshot: {
        javaHeapMb: value,
        nativeHeapMb: value,
        totalPssMb: value,
        timestamp: 2000,
        raw: "",
      },
      javaHeapGrowthMb: 0,
      nativeHeapGrowthMb: 0,
      totalPssGrowthMb: 0,
      gcEvents: [],
      gcCount: value,
      gcTotalDurationMs: value,
      unreachableObjects: { count: value, sizeKb: value, raw: "" },
    };
  }

  const capabilities: DeviceCapabilities = {
    refreshRate: 60,
    frameTimeMs: 1000 / 60,
  };

  test("feature flag initialization is idempotent under concurrent first initialization", async () => {
    const db = await openDb();
    const repository = new SqliteFeatureFlagRepository(db);

    await runConcurrentSameKeyStress({
      count: N,
      act: () => repository.ensureFlags(featureDefinitions),
    });

    const flags = await repository.listFlags();
    expect(flags.map((flag) => flag.key).sort()).toEqual(["accessibility-audit", "debug"]);
    expect(flags.find((flag) => flag.key === "accessibility-audit")?.config).toEqual({
      level: "AA",
    });
  });

  test("feature flag upsert is atomic under concurrent first writes", async () => {
    const db = await openDb();
    const repository = new SqliteFeatureFlagRepository(db);

    await runConcurrentSameKeyStress({
      count: N,
      act: (index) => repository.upsertFlag("debug", index % 2 === 0, { writer: index }),
    });

    const flags = await repository.listFlags();
    expect(flags).toHaveLength(1);
    expect(flags[0].key).toBe("debug");
    expect(flags[0].config).toHaveProperty("writer");
  });

  test("feature flag upsert preserves existing config when config is omitted", async () => {
    const db = await openDb();
    const repository = new SqliteFeatureFlagRepository(db);

    await repository.upsertFlag("debug", true, { writer: "initial" });
    await repository.upsertFlag("debug", false);

    const flags = await repository.listFlags();
    expect(flags).toEqual([
      {
        key: "debug",
        enabled: false,
        config: { writer: "initial" },
        updatedAt: expect.any(String),
      },
    ]);
  });

  test("storage previous-value auto-lookup serializes lookup and insert", async () => {
    const db = await openDb();
    await recordStorageEvent(
      {
        deviceId: "device-1",
        timestamp: 1000,
        applicationId: null,
        sessionId: null,
        fileName: "prefs.xml",
        key: "theme",
        value: "seed",
        valueType: null,
        changeType: "add",
      },
      db,
    );

    await runConcurrentSameKeyStress({
      count: N,
      act: (index) =>
        recordStorageEvent(
          {
            deviceId: "device-1",
            timestamp: 2000 + index,
            applicationId: null,
            sessionId: null,
            fileName: "prefs.xml",
            key: "theme",
            value: `value-${index}`,
            valueType: null,
            changeType: "modify",
          },
          db,
        ),
    });

    const events = await getStorageEvents({ deviceId: "device-1", limit: N + 1 }, db);
    const concurrentEvents = events.filter((event) => event.value !== "seed");
    expect(concurrentEvents).toHaveLength(N);
    expect(concurrentEvents.filter((event) => event.previousValue === "seed")).toHaveLength(1);
    expect(concurrentEvents.every((event) => event.previousValue !== null)).toBe(true);
    expect(
      concurrentEvents
        .filter((event) => event.previousValue !== "seed")
        .every((event) => event.previousValue?.startsWith("value-")),
    ).toBe(true);
  });

  test("direct suggestion promotion rolls back the fingerprint when linking fails", async () => {
    const db = await openDb();
    const repository = new NavigationRepository(db);
    await repository.getOrCreateApp("com.example.app");
    const node = await repository.getOrCreateNode("com.example.app", "Settings", 1000);
    const suggestion = await repository.addOrUpdateSuggestion(
      "com.example.app",
      "settings-fingerprint",
      "{}",
      2000,
    );
    await sql`
      CREATE TRIGGER fail_promote_update
      BEFORE UPDATE OF promoted_to_fingerprint_id ON navigation_suggestions
      WHEN NEW.promoted_to_fingerprint_id IS NOT NULL
      BEGIN
        SELECT RAISE(ABORT, 'injected promote failure');
      END
    `.execute(db);

    await expect(repository.promoteSuggestion(suggestion.id, node.id, 3000)).rejects.toThrow(
      /injected promote failure/,
    );

    const fingerprints = await db.selectFrom("navigation_node_fingerprints").selectAll().execute();
    expect(fingerprints).toHaveLength(0);
  });

  test("accessibility baseline saves use one row under concurrent first saves", async () => {
    const db = await openDb();
    const manager = new BaselineManager(db);

    await runConcurrentSameKeyStress({
      count: N,
      act: (index) => manager.saveBaseline("screen-1", [violation(`fp-${index}`)]),
    });

    const rows = await db.selectFrom("accessibility_baselines").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(JSON.parse(rows[0].violations_json)).toHaveLength(1);
  });

  test("memory baseline updates do not lose samples under concurrency", async () => {
    const db = await openDb();
    const manager = new MemoryBaselineManager(db);

    await runConcurrentSameKeyStress({
      count: N,
      act: () => manager.updateBaseline("device-1", "com.example.app", "tapOn", memoryMetrics(10)),
    });

    const baseline = await manager.getBaseline("device-1", "com.example.app", "tapOn");
    expect(baseline?.sample_count).toBe(N);
    expect(baseline?.java_heap_baseline_mb).toBe(10);
  });

  test("performance thresholds get-or-create stores one initial threshold under concurrency", async () => {
    const db = await openDb();
    const manager = new ThresholdManager(db);

    await runConcurrentSameKeyStress({
      count: N,
      act: () => manager.getOrCreateThresholds("device-1", capabilities),
    });

    const rows = await db.selectFrom("performance_thresholds").selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  test("performance threshold weight updates do not lose concurrent adjustments", async () => {
    const db = await openDb();
    const manager = new ThresholdManager(db);
    await manager.storeThresholds("device-1", capabilities, {
      frameTimeThresholdMs: 16,
      p50ThresholdMs: 12,
      p90ThresholdMs: 16,
      p95ThresholdMs: 20,
      p99ThresholdMs: 25,
      jankCountThreshold: 5,
      cpuUsageThresholdPercent: 80,
      touchLatencyThresholdMs: 32,
    });

    await runConcurrentSameKeyStress({
      count: 3,
      act: () =>
        manager.updateThresholdWeight("device-1", new Date().toISOString().split("T")[0], true),
    });

    const row = await db.selectFrom("performance_thresholds").selectAll().executeTakeFirstOrThrow();
    expect(row.weight).toBeCloseTo(1.331);
  });

  test("performance threshold weight update ignores expired threshold rows", async () => {
    const db = await openDb();
    const manager = new ThresholdManager(db);
    await db
      .insertInto("performance_thresholds")
      .values({
        device_id: "device-1",
        session_id: "expired-session",
        refresh_rate: 60,
        frame_time_threshold_ms: 16,
        p50_threshold_ms: 12,
        p90_threshold_ms: 16,
        p95_threshold_ms: 20,
        p99_threshold_ms: 25,
        jank_count_threshold: 5,
        cpu_usage_threshold_percent: 80,
        touch_latency_threshold_ms: 32,
        weight: 1,
        ttl_hours: 1,
        created_at: "2000-01-01T00:00:00.000Z",
      })
      .execute();

    await manager.updateThresholdWeight("device-1", "expired-session", true);

    const rows = await db.selectFrom("performance_thresholds").selectAll().execute();
    expect(rows).toHaveLength(0);
  });

  test("memory thresholds get-or-create stores one initial threshold under concurrency", async () => {
    const db = await openDb();
    const manager = new MemoryThresholdManager(db);

    await runConcurrentSameKeyStress({
      count: N,
      act: () => manager.getOrCreateThresholds("device-1", "com.example.app"),
    });

    const rows = await db.selectFrom("memory_thresholds").selectAll().execute();
    expect(rows).toHaveLength(1);
  });

  test("memory threshold weight updates do not lose concurrent adjustments", async () => {
    const db = await openDb();
    const manager = new MemoryThresholdManager(db);
    await manager.storeThresholds("device-1", "com.example.app", {
      heapGrowthThresholdMb: 50,
      nativeHeapGrowthThresholdMb: 30,
      gcCountThreshold: 10,
      gcDurationThresholdMs: 500,
      unreachableObjectsThreshold: 1000,
    });

    await runConcurrentSameKeyStress({
      count: 3,
      act: () => manager.updateThresholdWeight("device-1", "com.example.app", true),
    });

    const row = await db.selectFrom("memory_thresholds").selectAll().executeTakeFirstOrThrow();
    expect(row.weight).toBeCloseTo(1.331);
  });

  test("memory threshold weight update ignores expired threshold rows", async () => {
    const db = await openDb();
    const manager = new MemoryThresholdManager(db);
    await db
      .insertInto("memory_thresholds")
      .values({
        device_id: "device-1",
        package_name: "com.example.app",
        heap_growth_threshold_mb: 50,
        native_heap_growth_threshold_mb: 30,
        gc_count_threshold: 10,
        gc_duration_threshold_ms: 500,
        unreachable_objects_threshold: 1000,
        weight: 1,
        ttl_hours: 1,
        created_at: "2000-01-01T00:00:00.000Z",
      })
      .execute();

    await manager.updateThresholdWeight("device-1", "com.example.app", true);

    const rows = await db.selectFrom("memory_thresholds").selectAll().execute();
    expect(rows).toHaveLength(0);
  });
});
