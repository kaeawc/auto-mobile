import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type {
  Database,
  MemoryBaseline,
  NewMemoryThresholds,
  NewPerformanceThresholds,
  PerformanceThresholds,
} from "../../../src/db/types";
import { MemoryThresholdManager } from "../../../src/features/memory/MemoryThresholdManager";
import { ThresholdManager } from "../../../src/features/performance/ThresholdManager";
import {
  GenericThresholdManager,
  type ThresholdDescriptor,
} from "../../../src/features/shared/GenericThresholdManager";
import { DeviceCapabilitiesDetector } from "../../../src/utils/DeviceCapabilities";
import { createTestDatabase } from "../../db/testDbHelper";

function hoursAgo(hours: number): string {
  return new Date(Date.now() - hours * 60 * 60 * 1000).toISOString();
}

function performanceRow(
  overrides: Partial<NewPerformanceThresholds> = {},
): NewPerformanceThresholds {
  return {
    device_id: "device-1",
    session_id: "session-1",
    refresh_rate: 60,
    frame_time_threshold_ms: 16,
    p50_threshold_ms: 10,
    p90_threshold_ms: 20,
    p95_threshold_ms: 30,
    p99_threshold_ms: 40,
    jank_count_threshold: 5,
    cpu_usage_threshold_percent: 50,
    touch_latency_threshold_ms: 100,
    weight: 1,
    created_at: new Date().toISOString(),
    ttl_hours: 24,
    ...overrides,
  };
}

function memoryBaseline(overrides: Partial<MemoryBaseline> = {}): MemoryBaseline {
  return {
    id: 1,
    device_id: "device-1",
    package_name: "com.example.app",
    tool_name: "tapOn",
    java_heap_baseline_mb: 40,
    native_heap_baseline_mb: 20,
    gc_count_baseline: 3,
    gc_duration_baseline_ms: 150,
    unreachable_objects_baseline: 80,
    sample_count: 3,
    last_updated: new Date().toISOString(),
    created_at: new Date().toISOString(),
    ...overrides,
  };
}

describe("GenericThresholdManager", function () {
  const descriptor: ThresholdDescriptor<PerformanceThresholds> = {
    tableName: "performance_thresholds",
    logPrefix: "TestThresholdManager",
    weightedColumns: [
      { column: "frame_time_threshold_ms" },
      { column: "jank_count_threshold", round: true },
    ],
    modeColumns: ["refresh_rate"],
  };

  test("calculates descriptor-driven weighted averages and modes", function () {
    const manager = new GenericThresholdManager(descriptor);
    const rows = [
      {
        ...performanceRow({
          refresh_rate: 60,
          frame_time_threshold_ms: 10,
          jank_count_threshold: 1,
          weight: 1,
        }),
        id: 1,
        created_at: "2026-01-01T00:00:00.000Z",
      },
      {
        ...performanceRow({
          refresh_rate: 120,
          frame_time_threshold_ms: 20,
          jank_count_threshold: 4,
          weight: 3,
        }),
        id: 2,
        created_at: "2026-01-02T00:00:00.000Z",
      },
      {
        ...performanceRow({
          refresh_rate: 120,
          frame_time_threshold_ms: 40,
          jank_count_threshold: 10,
          weight: 0,
        }),
        id: 3,
        created_at: "2026-01-03T00:00:00.000Z",
      },
    ] as PerformanceThresholds[];

    const weighted = manager.calculateWeightedAverageThresholds(rows);

    expect(weighted).toEqual({
      refresh_rate: 120,
      frame_time_threshold_ms: 17.5,
      jank_count_threshold: 3,
      weight: 1,
      ttl_hours: 24,
    });
  });
});

describe("ThresholdManager wrappers", function () {
  let db: Kysely<Database>;

  beforeEach(async function () {
    db = await createTestDatabase();
  });

  afterEach(async function () {
    await db.destroy();
  });

  test("performance thresholds keep weighted averages, refresh-rate mode, and rounded jank", async function () {
    const manager = new ThresholdManager(db);
    await db
      .insertInto("performance_thresholds")
      .values([
        performanceRow({
          refresh_rate: 60,
          p50_threshold_ms: 10,
          p90_threshold_ms: 20,
          p95_threshold_ms: 30,
          p99_threshold_ms: 40,
          frame_time_threshold_ms: 16,
          jank_count_threshold: 1,
          cpu_usage_threshold_percent: 50,
          touch_latency_threshold_ms: 100,
          weight: 1,
        }),
        performanceRow({
          session_id: "session-2",
          refresh_rate: 120,
          p50_threshold_ms: 30,
          p90_threshold_ms: 60,
          p95_threshold_ms: 90,
          p99_threshold_ms: 120,
          frame_time_threshold_ms: 32,
          jank_count_threshold: 4,
          cpu_usage_threshold_percent: 70,
          touch_latency_threshold_ms: 140,
          weight: 3,
        }),
        performanceRow({
          session_id: "session-3",
          refresh_rate: 120,
          created_at: hoursAgo(48),
          ttl_hours: 1,
          weight: 100,
        }),
      ])
      .execute();

    const thresholds = await manager.getOrCreateThresholds("device-1", {
      refreshRate: 60,
      frameTimeMs: 16.67,
    });

    expect(thresholds).toEqual({
      frameTimeThresholdMs: 28,
      p50ThresholdMs: 25,
      p90ThresholdMs: 50,
      p95ThresholdMs: 75,
      p99ThresholdMs: 100,
      jankCountThreshold: 3,
      cpuUsageThresholdPercent: 65,
      touchLatencyThresholdMs: 130,
    });
  });

  test("performance threshold weight updates the requested session", async function () {
    const manager = new ThresholdManager(db);
    await db
      .insertInto("performance_thresholds")
      .values([
        performanceRow({ session_id: "old-session", weight: 1 }),
        performanceRow({ session_id: "target-session", weight: 1 }),
      ])
      .execute();

    await manager.updateThresholdWeight("device-1", "target-session", true);

    const rows = await db
      .selectFrom("performance_thresholds")
      .select(["session_id", "weight"])
      .orderBy("session_id")
      .execute();
    expect(rows).toEqual([
      { session_id: "old-session", weight: 1 },
      { session_id: "target-session", weight: 1.1 },
    ]);
  });

  test("performance thresholds create capability-derived defaults and persist them", async function () {
    const manager = new ThresholdManager(db);
    const capabilities = {
      refreshRate: 120,
      frameTimeMs: 1000 / 120,
    };

    const thresholds = await manager.getOrCreateThresholds("device-1", capabilities);
    const expected = DeviceCapabilitiesDetector.calculateDefaultThresholds(capabilities);
    const rows = await db.selectFrom("performance_thresholds").selectAll().execute();

    expect(thresholds).toEqual(expected);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      device_id: "device-1",
      session_id: new Date().toISOString().split("T")[0],
      refresh_rate: 120,
      frame_time_threshold_ms: expected.frameTimeThresholdMs,
      p50_threshold_ms: expected.p50ThresholdMs,
      p90_threshold_ms: expected.p90ThresholdMs,
      p95_threshold_ms: expected.p95ThresholdMs,
      p99_threshold_ms: expected.p99ThresholdMs,
      jank_count_threshold: expected.jankCountThreshold,
      cpu_usage_threshold_percent: expected.cpuUsageThresholdPercent,
      touch_latency_threshold_ms: expected.touchLatencyThresholdMs,
      weight: 1,
      ttl_hours: 24,
    });
  });

  test("performance public methods store, read, average, and cleanup thresholds", async function () {
    const manager = new ThresholdManager(db);
    const capabilities = { refreshRate: 60, frameTimeMs: 16.67 };
    await manager.storeThresholds(
      "device-1",
      capabilities,
      {
        frameTimeThresholdMs: 16,
        p50ThresholdMs: 10,
        p90ThresholdMs: 20,
        p95ThresholdMs: 30,
        p99ThresholdMs: 40,
        jankCountThreshold: 5,
        cpuUsageThresholdPercent: 50,
        touchLatencyThresholdMs: 100,
      },
      1,
      24,
    );
    await db
      .insertInto("performance_thresholds")
      .values(
        performanceRow({
          device_id: "device-1",
          session_id: "expired-session",
          created_at: hoursAgo(48),
          ttl_hours: 1,
        }),
      )
      .execute();

    await manager.cleanupExpiredThresholds("device-1");
    const valid = await manager.getValidThresholds("device-1");
    const weighted = manager.calculateWeightedAverageThresholds(valid);

    expect(valid).toHaveLength(1);
    expect(valid[0].session_id).not.toBe("expired-session");
    expect(weighted).toMatchObject({
      refresh_rate: 60,
      frame_time_threshold_ms: 16,
      p50_threshold_ms: 10,
      jank_count_threshold: 5,
      weight: 1,
      ttl_hours: 24,
    });
  });

  test("memory thresholds stay scoped by package and use weighted averages", async function () {
    const manager = new MemoryThresholdManager(db);
    const rows: NewMemoryThresholds[] = [
      {
        device_id: "device-1",
        package_name: "com.example.app",
        heap_growth_threshold_mb: 10,
        native_heap_growth_threshold_mb: 20,
        gc_count_threshold: 1,
        gc_duration_threshold_ms: 100,
        unreachable_objects_threshold: 50,
        weight: 1,
        created_at: new Date().toISOString(),
        ttl_hours: 24,
      },
      {
        device_id: "device-1",
        package_name: "com.example.app",
        heap_growth_threshold_mb: 30,
        native_heap_growth_threshold_mb: 60,
        gc_count_threshold: 4,
        gc_duration_threshold_ms: 300,
        unreachable_objects_threshold: 150,
        weight: 3,
        created_at: new Date().toISOString(),
        ttl_hours: 24,
      },
      {
        device_id: "device-1",
        package_name: "com.other.app",
        heap_growth_threshold_mb: 999,
        native_heap_growth_threshold_mb: 999,
        gc_count_threshold: 999,
        gc_duration_threshold_ms: 999,
        unreachable_objects_threshold: 999,
        weight: 999,
        created_at: new Date().toISOString(),
        ttl_hours: 24,
      },
    ];
    await db.insertInto("memory_thresholds").values(rows).execute();

    const thresholds = await manager.getOrCreateThresholds("device-1", "com.example.app");

    expect(thresholds).toEqual({
      heapGrowthThresholdMb: 25,
      nativeHeapGrowthThresholdMb: 50,
      gcCountThreshold: 3,
      gcDurationThresholdMs: 250,
      unreachableObjectsThreshold: 125,
    });
  });

  test("memory thresholds preserve baseline and default-profile fallbacks", async function () {
    const manager = new MemoryThresholdManager(db);

    const adaptive = await manager.getOrCreateThresholds(
      "device-1",
      "com.example.app",
      memoryBaseline(),
    );
    const relaxed = await manager.getOrCreateThresholds(
      "device-1",
      "com.relaxed.app",
      null,
      "relaxed",
    );

    expect(adaptive).toEqual({
      heapGrowthThresholdMb: 80,
      nativeHeapGrowthThresholdMb: 40,
      gcCountThreshold: 6,
      gcDurationThresholdMs: 300,
      unreachableObjectsThreshold: 160,
    });
    expect(relaxed).toEqual({
      heapGrowthThresholdMb: 100,
      nativeHeapGrowthThresholdMb: 75,
      gcCountThreshold: 20,
      gcDurationThresholdMs: 1000,
      unreachableObjectsThreshold: 2000,
    });

    const rows = await db
      .selectFrom("memory_thresholds")
      .selectAll()
      .orderBy("package_name")
      .execute();
    expect(rows).toHaveLength(2);
    expect(rows).toEqual([
      expect.objectContaining({
        device_id: "device-1",
        package_name: "com.example.app",
        heap_growth_threshold_mb: 80,
        native_heap_growth_threshold_mb: 40,
        gc_count_threshold: 6,
        gc_duration_threshold_ms: 300,
        unreachable_objects_threshold: 160,
        weight: 1,
        ttl_hours: 24,
      }),
      expect.objectContaining({
        device_id: "device-1",
        package_name: "com.relaxed.app",
        heap_growth_threshold_mb: 100,
        native_heap_growth_threshold_mb: 75,
        gc_count_threshold: 20,
        gc_duration_threshold_ms: 1000,
        unreachable_objects_threshold: 2000,
        weight: 1,
        ttl_hours: 24,
      }),
    ]);
  });

  test("memory threshold weight updates the most recent valid package threshold", async function () {
    const manager = new MemoryThresholdManager(db);
    await db
      .insertInto("memory_thresholds")
      .values([
        {
          device_id: "device-1",
          package_name: "com.example.app",
          heap_growth_threshold_mb: 10,
          native_heap_growth_threshold_mb: 20,
          gc_count_threshold: 1,
          gc_duration_threshold_ms: 100,
          unreachable_objects_threshold: 50,
          weight: 1,
          ttl_hours: 24,
          created_at: hoursAgo(2),
        },
        {
          device_id: "device-1",
          package_name: "com.example.app",
          heap_growth_threshold_mb: 30,
          native_heap_growth_threshold_mb: 60,
          gc_count_threshold: 4,
          gc_duration_threshold_ms: 300,
          unreachable_objects_threshold: 150,
          weight: 1,
          created_at: new Date().toISOString(),
          ttl_hours: 24,
        },
      ])
      .execute();

    await manager.updateThresholdWeight("device-1", "com.example.app", false);

    const rows = await db
      .selectFrom("memory_thresholds")
      .select(["heap_growth_threshold_mb", "weight"])
      .orderBy("created_at")
      .execute();
    expect(rows).toEqual([
      { heap_growth_threshold_mb: 10, weight: 1 },
      { heap_growth_threshold_mb: 30, weight: 0.9 },
    ]);
  });

  test("memory public methods store, read, average, and cleanup package thresholds", async function () {
    const manager = new MemoryThresholdManager(db);
    await manager.storeThresholds("device-1", "com.example.app", {
      heapGrowthThresholdMb: 20,
      nativeHeapGrowthThresholdMb: 30,
      gcCountThreshold: 4,
      gcDurationThresholdMs: 200,
      unreachableObjectsThreshold: 100,
    });
    await db
      .insertInto("memory_thresholds")
      .values({
        device_id: "device-1",
        package_name: "com.example.app",
        heap_growth_threshold_mb: 999,
        native_heap_growth_threshold_mb: 999,
        gc_count_threshold: 999,
        gc_duration_threshold_ms: 999,
        unreachable_objects_threshold: 999,
        weight: 999,
        ttl_hours: 1,
        created_at: hoursAgo(48),
      })
      .execute();

    await manager.cleanupExpiredThresholds("device-1");
    const valid = await manager.getValidThresholds("device-1", "com.example.app");
    const weighted = manager.calculateWeightedAverageThresholds(valid);

    expect(valid).toHaveLength(1);
    expect(valid[0]).toMatchObject({
      package_name: "com.example.app",
      heap_growth_threshold_mb: 20,
      gc_count_threshold: 4,
    });
    expect(weighted).toMatchObject({
      heap_growth_threshold_mb: 20,
      native_heap_growth_threshold_mb: 30,
      gc_count_threshold: 4,
      weight: 1,
      ttl_hours: 24,
    });
  });
});
