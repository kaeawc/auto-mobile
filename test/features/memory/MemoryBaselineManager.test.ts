import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import { MemoryBaselineManager } from "../../../src/features/memory/MemoryBaselineManager";
import type {
  Database as DatabaseSchema,
  MemoryBaseline,
  NewMemoryBaseline,
} from "../../../src/db/types";
import type { MemoryMetrics } from "../../../src/features/memory/MemoryMetricsCollector";
import { createTestDatabase } from "../../db/testDbHelper";

/** Render a Date as SQLite's `YYYY-MM-DD HH:MM:SS` (UTC) — the format a
 * `datetime('now')` column default produces (no `T`, no `Z`, no milliseconds). */
function toSqliteFormat(date: Date): string {
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

describe("MemoryBaselineManager - Unit Tests", function () {
  let manager: MemoryBaselineManager;

  beforeEach(function () {
    manager = new MemoryBaselineManager();
  });

  // Note: exponentialMovingAverage tests moved to MetricsUtils.test.ts

  describe("calculateAnomalyMultiplier", function () {
    test("should calculate multipliers correctly for normal growth", function () {
      const baseline: MemoryBaseline = {
        id: 1,
        device_id: "test-device",
        package_name: "com.example.app",
        tool_name: "tapOn",
        java_heap_baseline_mb: 50,
        native_heap_baseline_mb: 30,
        gc_count_baseline: 5,
        gc_duration_baseline_ms: 100,
        unreachable_objects_baseline: 100,
        sample_count: 10,
        last_updated: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      const metrics: MemoryMetrics = {
        preSnapshot: {
          javaHeapMb: 45,
          nativeHeapMb: 28,
          totalPssMb: 100,
          timestamp: Date.now(),
          raw: "",
        },
        postSnapshot: {
          javaHeapMb: 100, // 2x baseline
          nativeHeapMb: 60, // 2x baseline
          totalPssMb: 200,
          timestamp: Date.now(),
          raw: "",
        },
        javaHeapGrowthMb: 55,
        nativeHeapGrowthMb: 32,
        totalPssGrowthMb: 100,
        gcEvents: [],
        gcCount: 10, // 2x baseline
        gcTotalDurationMs: 200, // 2x baseline
        unreachableObjects: {
          count: 200, // 2x baseline
          sizeKb: 10,
          raw: "",
        },
      };

      const result = manager.calculateAnomalyMultiplier(baseline, metrics);

      expect(result.javaHeapMultiplier).toBe(2.0);
      expect(result.nativeHeapMultiplier).toBe(2.0);
      expect(result.gcCountMultiplier).toBe(2.0);
      expect(result.gcDurationMultiplier).toBe(2.0);
      expect(result.unreachableObjectsMultiplier).toBe(2.0);
    });

    test("should handle zero baseline values safely", function () {
      const baseline: MemoryBaseline = {
        id: 1,
        device_id: "test-device",
        package_name: "com.example.app",
        tool_name: "tapOn",
        java_heap_baseline_mb: 0,
        native_heap_baseline_mb: 0,
        gc_count_baseline: 0,
        gc_duration_baseline_ms: 0,
        unreachable_objects_baseline: 0,
        sample_count: 1,
        last_updated: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      const metrics: MemoryMetrics = {
        preSnapshot: {
          javaHeapMb: 0,
          nativeHeapMb: 0,
          totalPssMb: 0,
          timestamp: Date.now(),
          raw: "",
        },
        postSnapshot: {
          javaHeapMb: 50,
          nativeHeapMb: 30,
          totalPssMb: 100,
          timestamp: Date.now(),
          raw: "",
        },
        javaHeapGrowthMb: 50,
        nativeHeapGrowthMb: 30,
        totalPssGrowthMb: 100,
        gcEvents: [],
        gcCount: 5,
        gcTotalDurationMs: 100,
        unreachableObjects: {
          count: 50,
          sizeKb: 5,
          raw: "",
        },
      };

      const result = manager.calculateAnomalyMultiplier(baseline, metrics);

      // When baseline is 0 and current > 0, should return Infinity
      expect(result.javaHeapMultiplier).toBe(Infinity);
      expect(result.nativeHeapMultiplier).toBe(Infinity);
      expect(result.gcCountMultiplier).toBe(Infinity);
      expect(result.gcDurationMultiplier).toBe(Infinity);
      expect(result.unreachableObjectsMultiplier).toBe(Infinity);
    });

    test("should handle zero current values", function () {
      const baseline: MemoryBaseline = {
        id: 1,
        device_id: "test-device",
        package_name: "com.example.app",
        tool_name: "tapOn",
        java_heap_baseline_mb: 50,
        native_heap_baseline_mb: 30,
        gc_count_baseline: 5,
        gc_duration_baseline_ms: 100,
        unreachable_objects_baseline: 100,
        sample_count: 10,
        last_updated: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      const metrics: MemoryMetrics = {
        preSnapshot: {
          javaHeapMb: 50,
          nativeHeapMb: 30,
          totalPssMb: 100,
          timestamp: Date.now(),
          raw: "",
        },
        postSnapshot: {
          javaHeapMb: 0,
          nativeHeapMb: 0,
          totalPssMb: 0,
          timestamp: Date.now(),
          raw: "",
        },
        javaHeapGrowthMb: -50,
        nativeHeapGrowthMb: -30,
        totalPssGrowthMb: -100,
        gcEvents: [],
        gcCount: 0,
        gcTotalDurationMs: 0,
        unreachableObjects: {
          count: 0,
          sizeKb: 0,
          raw: "",
        },
      };

      const result = manager.calculateAnomalyMultiplier(baseline, metrics);

      // All multipliers should be 0
      expect(result.javaHeapMultiplier).toBe(0);
      expect(result.nativeHeapMultiplier).toBe(0);
      expect(result.gcCountMultiplier).toBe(0);
      expect(result.gcDurationMultiplier).toBe(0);
      expect(result.unreachableObjectsMultiplier).toBe(0);
    });

    test("should handle null unreachable objects", function () {
      const baseline: MemoryBaseline = {
        id: 1,
        device_id: "test-device",
        package_name: "com.example.app",
        tool_name: "tapOn",
        java_heap_baseline_mb: 50,
        native_heap_baseline_mb: 30,
        gc_count_baseline: 5,
        gc_duration_baseline_ms: 100,
        unreachable_objects_baseline: 100,
        sample_count: 10,
        last_updated: new Date().toISOString(),
        created_at: new Date().toISOString(),
      };

      const metrics: MemoryMetrics = {
        preSnapshot: {
          javaHeapMb: 45,
          nativeHeapMb: 28,
          totalPssMb: 100,
          timestamp: Date.now(),
          raw: "",
        },
        postSnapshot: {
          javaHeapMb: 50,
          nativeHeapMb: 30,
          totalPssMb: 100,
          timestamp: Date.now(),
          raw: "",
        },
        javaHeapGrowthMb: 5,
        nativeHeapGrowthMb: 2,
        totalPssGrowthMb: 0,
        gcEvents: [],
        gcCount: 5,
        gcTotalDurationMs: 100,
        unreachableObjects: null,
      };

      const result = manager.calculateAnomalyMultiplier(baseline, metrics);

      // Unreachable objects multiplier should be 0 when null
      expect(result.unreachableObjectsMultiplier).toBe(0);
    });

    // Ratio table exercising the safeDivide boundaries every multiplier shares.
    // Uses `new MemoryBaselineManager()` with NO database — calculateAnomalyMultiplier
    // is pure and the lazy `db` getter is never resolved (issue #3067).
    describe("multiplier ratios", function () {
      const pureManager = new MemoryBaselineManager();

      function baselineWithJava(javaBaseline: number): MemoryBaseline {
        return {
          id: 1,
          device_id: "test-device",
          package_name: "com.example.app",
          tool_name: "tapOn",
          java_heap_baseline_mb: javaBaseline,
          native_heap_baseline_mb: 30,
          gc_count_baseline: 5,
          gc_duration_baseline_ms: 100,
          unreachable_objects_baseline: 100,
          sample_count: 10,
          last_updated: new Date().toISOString(),
          created_at: new Date().toISOString(),
        };
      }

      function metricsWithJava(javaCurrent: number): MemoryMetrics {
        const snapshot = {
          javaHeapMb: javaCurrent,
          nativeHeapMb: 30,
          totalPssMb: 100,
          timestamp: 0,
          raw: "",
        };
        return {
          preSnapshot: snapshot,
          postSnapshot: snapshot,
          javaHeapGrowthMb: 0,
          nativeHeapGrowthMb: 0,
          totalPssGrowthMb: 0,
          gcEvents: [],
          gcCount: 5,
          gcTotalDurationMs: 100,
          unreachableObjects: null,
        };
      }

      const cases: Array<[string, number, number, number]> = [
        ["doubled heap is 2x", 100, 50, 2],
        ["unchanged heap is 1x", 50, 50, 1],
        ["shrunk heap is a fractional multiplier (negative growth)", 25, 50, 0.5],
        ["strongly shrunk heap approaches zero", 5, 50, 0.1],
        ["zero current over positive baseline is 0", 0, 50, 0],
        ["positive current over zero baseline is Infinity", 100, 0, Infinity],
        ["zero current over zero baseline collapses to 1.0", 0, 0, 1.0],
      ];

      test.each(cases)("%s", function (_name, current, baseline, expected) {
        const result = pureManager.calculateAnomalyMultiplier(
          baselineWithJava(baseline),
          metricsWithJava(current),
        );
        expect(result.javaHeapMultiplier).toBe(expected);
      });
    });
  });

  describe("updateBaseline EMA blend", function () {
    let testDb: Kysely<DatabaseSchema>;
    let dbManager: MemoryBaselineManager;

    beforeEach(async function () {
      testDb = await createTestDatabase();
      dbManager = new MemoryBaselineManager(testDb);
    });

    afterEach(async function () {
      await testDb.destroy();
    });

    function makeMetrics(values: {
      java: number;
      native: number;
      gcCount: number;
      gcDur: number;
      unreachable: number;
    }): MemoryMetrics {
      const snapshot = {
        javaHeapMb: values.java,
        nativeHeapMb: values.native,
        totalPssMb: values.java + values.native,
        timestamp: 0,
        raw: "",
      };
      return {
        preSnapshot: snapshot,
        postSnapshot: snapshot,
        javaHeapGrowthMb: 0,
        nativeHeapGrowthMb: 0,
        totalPssGrowthMb: 0,
        gcEvents: [],
        gcCount: values.gcCount,
        gcTotalDurationMs: values.gcDur,
        unreachableObjects: { count: values.unreachable } as MemoryMetrics["unreachableObjects"],
      } as MemoryMetrics;
    }

    test("stores the raw metrics as the baseline on the first observation", async function () {
      await dbManager.updateBaseline(
        "device-1",
        "com.example.app",
        "tapOn",
        makeMetrics({ java: 100, native: 40, gcCount: 8, gcDur: 200, unreachable: 10 }),
      );

      const baseline = await dbManager.getBaseline("device-1", "com.example.app", "tapOn");
      expect(baseline?.java_heap_baseline_mb).toBeCloseTo(100);
      expect(baseline?.native_heap_baseline_mb).toBeCloseTo(40);
      expect(baseline?.sample_count).toBe(1);
    });

    test("blends a second observation as alpha*new + (1-alpha)*old", async function () {
      await dbManager.updateBaseline(
        "device-1",
        "com.example.app",
        "tapOn",
        makeMetrics({ java: 100, native: 80, gcCount: 10, gcDur: 200, unreachable: 100 }),
      );

      // alpha 0.3: java = 0.3*60 + 0.7*100 = 88 (an inverted alpha would give 72).
      await dbManager.updateBaseline(
        "device-1",
        "com.example.app",
        "tapOn",
        makeMetrics({ java: 60, native: 30, gcCount: 20, gcDur: 100, unreachable: 200 }),
        0.3,
      );

      const baseline = await dbManager.getBaseline("device-1", "com.example.app", "tapOn");
      expect(baseline?.java_heap_baseline_mb).toBeCloseTo(88);
      expect(baseline?.native_heap_baseline_mb).toBeCloseTo(0.3 * 30 + 0.7 * 80);
      expect(baseline?.gc_count_baseline).toBeCloseTo(0.3 * 20 + 0.7 * 10);
      expect(baseline?.sample_count).toBe(2);
    });

    test("uses the default EMA alpha of 0.3 when none is supplied", async function () {
      await dbManager.updateBaseline(
        "device-1",
        "com.example.app",
        "tapOn",
        makeMetrics({ java: 100, native: 80, gcCount: 10, gcDur: 200, unreachable: 100 }),
      );
      // No alpha argument -> DEFAULT_EMA_ALPHA (0.3): 0.3*60 + 0.7*100 = 88.
      await dbManager.updateBaseline(
        "device-1",
        "com.example.app",
        "tapOn",
        makeMetrics({ java: 60, native: 30, gcCount: 20, gcDur: 100, unreachable: 200 }),
      );

      const baseline = await dbManager.getBaseline("device-1", "com.example.app", "tapOn");
      expect(baseline?.java_heap_baseline_mb).toBeCloseTo(88);
    });
  });

  describe("cleanupStaleBaselines", function () {
    let testDb: Kysely<DatabaseSchema>;
    let dbManager: MemoryBaselineManager;

    beforeEach(async function () {
      testDb = await createTestDatabase();
      dbManager = new MemoryBaselineManager(testDb);
    });

    afterEach(async function () {
      await testDb.destroy();
    });

    function baselineRow(toolName: string, lastUpdated: string): NewMemoryBaseline {
      return {
        device_id: "test-device",
        package_name: "com.example.app",
        tool_name: toolName,
        java_heap_baseline_mb: 50,
        native_heap_baseline_mb: 30,
        gc_count_baseline: 5,
        gc_duration_baseline_ms: 100,
        unreachable_objects_baseline: 100,
        sample_count: 1,
        last_updated: lastUpdated,
      };
    }

    async function remainingToolNames(): Promise<string[]> {
      const rows = await testDb.selectFrom("memory_baselines").select("tool_name").execute();
      return rows.map((row) => row.tool_name).sort();
    }

    test("should delete only ISO rows older than the cutoff", async function () {
      const daysOld = 30;
      const ancientIso = new Date("2000-01-01T00:00:00Z").toISOString();
      const recentIso = new Date().toISOString();

      await testDb
        .insertInto("memory_baselines")
        .values([baselineRow("ancient", ancientIso), baselineRow("recent", recentIso)])
        .execute();

      await dbManager.cleanupStaleBaselines(daysOld);

      expect(await remainingToolNames()).toEqual(["recent"]);
    });

    test("should not delete a SQLite-format row that is newer than the cutoff (#3157)", async function () {
      // Regression guard for the ISO-vs-`datetime('now')` format trap (#2937's
      // sibling). If a defaulted `last_updated` writer ever lands, the column can
      // hold SQLite's `YYYY-MM-DD HH:MM:SS` form. A naive string `<` against the
      // ISO-8601 cutoff compares the two lexically: at the date/time separator a
      // SQLite space (0x20) sorts before the ISO `T` (0x54), so a row on the SAME
      // calendar date as the cutoff but at a LATER time-of-day sorts BEFORE the
      // cutoff and would be wrongly deleted despite being newer. `datetime(...)`
      // normalization compares them as real instants.
      const daysOld = 30;
      const cutoff = new Date();
      cutoff.setDate(cutoff.getDate() - daysOld);

      // Same UTC date as the cutoff, at end-of-day — chronologically newer than
      // the cutoff instant (tests do not run in the final second of a UTC day),
      // yet lexically smaller than the ISO cutoff string.
      const sameDay = cutoff.toISOString().slice(0, 10);
      const newerSqliteFormat = `${sameDay} 23:59:59`;

      // An unambiguously ancient SQLite-format row that must still be deleted.
      const ancientSqliteFormat = toSqliteFormat(new Date("2000-01-01T00:00:00Z"));

      await testDb
        .insertInto("memory_baselines")
        .values([
          baselineRow("boundary_newer", newerSqliteFormat),
          baselineRow("ancient", ancientSqliteFormat),
        ])
        .execute();

      await dbManager.cleanupStaleBaselines(daysOld);

      // Only the genuinely-ancient row is removed; the newer boundary row lives.
      expect(await remainingToolNames()).toEqual(["boundary_newer"]);
    });
  });
});
