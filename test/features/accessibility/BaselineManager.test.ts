/**
 * Unit tests for BaselineManager
 * Tests baseline CRUD operations and database interactions
 *
 * The real `BaselineManager` is exercised directly with an injected in-memory
 * database (its constructor takes an optional `Kysely<Database>`, resolved lazily
 * so construction never touches the file-backed singleton — issue #3067). The
 * database is built from the real migration chain so `saveBaseline` can rely on
 * the schema's `created_at`/`updated_at` defaults exactly as it does in
 * production.
 */

import { expect, describe, it, test, beforeEach, afterEach } from "bun:test";
import type { WcagViolation } from "../../../src/models/AccessibilityAudit";
import { createTestDatabase } from "../../db/testDbHelper";
import { BaselineManager } from "../../../src/features/accessibility/BaselineManager";
import type { Kysely } from "kysely";
import type { Database as DatabaseSchema } from "../../../src/db/types";

/** Render a Date as SQLite's `YYYY-MM-DD HH:MM:SS` (UTC) — the format a
 * `datetime('now')` column default produces (no `T`, no `Z`, no milliseconds). */
function toSqliteFormat(date: Date): string {
  return date
    .toISOString()
    .replace("T", " ")
    .replace(/\.\d{3}Z$/, "");
}

describe("BaselineManager", function () {
  let testDb: Kysely<DatabaseSchema>;
  let manager: BaselineManager;

  beforeEach(async function () {
    testDb = await createTestDatabase();
    manager = new BaselineManager(testDb);
  });

  afterEach(async function () {
    await testDb.destroy();
  });

  describe("CRUD Operations", function () {
    const mockViolations: WcagViolation[] = [
      {
        type: "missing-content-description",
        severity: "error",
        criterion: "1.1.1",
        message: "Interactive element lacks content description",
        element: {
          bounds: { left: 0, top: 0, right: 100, bottom: 50 },
          clickable: true,
        },
        fingerprint: "abc123",
      },
      {
        type: "insufficient-contrast",
        severity: "error",
        criterion: "1.4.3",
        message: "Text contrast ratio too low",
        element: {
          bounds: { left: 0, top: 50, right: 100, bottom: 100 },
          text: "Low contrast text",
        },
        details: { ratio: 2.5, required: 4.5 },
        fingerprint: "def456",
      },
    ];

    it("should save baseline to database", async function () {
      const screenId = "com.example.app.MainActivity";

      await manager.saveBaseline(screenId, mockViolations);

      const baseline = await manager.getBaseline(screenId);
      expect(baseline).not.toBeNull();
      expect(baseline!.screenId).toBe(screenId);
      expect(baseline!.violations).toHaveLength(2);
      expect(baseline!.violations[0].fingerprint).toBe("abc123");
    });

    it("should retrieve baseline by screen ID", async function () {
      const screenId = "com.example.app.SettingsActivity";

      await manager.saveBaseline(screenId, mockViolations);
      const baseline = await manager.getBaseline(screenId);

      expect(baseline).not.toBeNull();
      expect(baseline!.screenId).toBe(screenId);
      expect(baseline!.violations).toEqual(mockViolations);
    });

    it("should update existing baseline", async function () {
      const screenId = "com.example.app.MainActivity";

      // Save initial baseline
      await manager.saveBaseline(screenId, mockViolations);

      // Update with new violations
      const newViolations: WcagViolation[] = [
        {
          type: "touch-target-too-small",
          severity: "warning",
          criterion: "2.5.5",
          message: "Touch target smaller than 44x44dp",
          element: {
            bounds: { left: 0, top: 0, right: 30, bottom: 30 },
            clickable: true,
          },
          fingerprint: "ghi789",
        },
      ];

      await manager.saveBaseline(screenId, newViolations);

      const baseline = await manager.getBaseline(screenId);
      expect(baseline).not.toBeNull();
      expect(baseline!.violations).toHaveLength(1);
      expect(baseline!.violations[0].fingerprint).toBe("ghi789");
    });

    it("should delete baseline", async function () {
      const screenId = "com.example.app.MainActivity";

      await manager.saveBaseline(screenId, mockViolations);
      await manager.clearBaseline(screenId);

      const baseline = await manager.getBaseline(screenId);
      expect(baseline).toBeNull();
    });

    it("should list all baselines", async function () {
      await manager.saveBaseline("screen1", mockViolations.slice(0, 1));
      await manager.saveBaseline("screen2", mockViolations.slice(1, 2));
      await manager.saveBaseline("screen3", mockViolations);

      const baselines = await manager.listBaselines();
      expect(baselines).toHaveLength(3);

      const screenIds = baselines.map((b) => b.screenId);
      expect(screenIds).toEqual(expect.arrayContaining(["screen1", "screen2", "screen3"]));
    });

    it("should clear all baselines", async function () {
      await manager.saveBaseline("screen1", mockViolations);
      await manager.saveBaseline("screen2", mockViolations);
      await manager.saveBaseline("screen3", mockViolations);

      await manager.clearAllBaselines();

      const baselines = await manager.listBaselines();
      expect(baselines).toHaveLength(0);
    });
  });

  describe("Filtering", function () {
    it("should handle empty baseline", async function () {
      const baseline = await manager.getBaseline("nonexistent");
      expect(baseline).toBeNull();
    });

    it("should handle baseline with empty violations array", async function () {
      const screenId = "com.example.app.EmptyScreen";

      await manager.saveBaseline(screenId, []);

      const baseline = await manager.getBaseline(screenId);
      expect(baseline).not.toBeNull();
      expect(baseline!.violations).toHaveLength(0);
    });
  });

  describe("Cleanup", function () {
    it("should cleanup old baselines", async function () {
      // Create a baseline with an old updated_at timestamp
      const now = new Date();
      const oldDate = new Date(now.getTime() - 31 * 24 * 60 * 60 * 1000); // 31 days ago

      // Insert directly into database with old timestamp
      await testDb
        .insertInto("accessibility_baselines")
        .values({
          screen_id: "old_screen",
          violations_json: JSON.stringify([]),
          created_at: oldDate.toISOString(),
          updated_at: oldDate.toISOString(),
        })
        .execute();

      // Insert a recent one
      await manager.saveBaseline("recent_screen", []);

      // Clean up baselines older than 30 days
      const deletedCount = await manager.cleanupOldBaselines(30);

      expect(deletedCount).toBe(1);

      // Verify old one is gone but recent one remains
      const oldBaseline = await manager.getBaseline("old_screen");
      const recentBaseline = await manager.getBaseline("recent_screen");

      expect(oldBaseline).toBeNull();
      expect(recentBaseline).not.toBeNull();
    });

    it("should return 0 when no baselines to cleanup", async function () {
      await manager.saveBaseline("recent_screen", []);

      const deletedCount = await manager.cleanupOldBaselines(30);

      expect(deletedCount).toBe(0);
    });

    it("should not delete a SQLite-format row that is newer than the cutoff (#2937)", async function () {
      // Regression guard for the ISO-vs-`datetime('now')` format trap. Once a
      // defaulted `updated_at` writer lands, the column can hold SQLite's
      // `YYYY-MM-DD HH:MM:SS` form. A naive string `<` against the ISO-8601 cutoff
      // compares the two lexically: at the date/time separator a SQLite space
      // (0x20) sorts before the ISO `T` (0x54), so a row on the SAME calendar date
      // as the cutoff but at a LATER time-of-day sorts BEFORE the cutoff and would
      // be wrongly deleted despite being newer. `datetime(...)` normalization
      // compares them as real instants.
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
        .insertInto("accessibility_baselines")
        .values({
          screen_id: "boundary_newer",
          violations_json: "[]",
          created_at: newerSqliteFormat,
          updated_at: newerSqliteFormat,
        })
        .execute();
      await testDb
        .insertInto("accessibility_baselines")
        .values({
          screen_id: "ancient",
          violations_json: "[]",
          created_at: ancientSqliteFormat,
          updated_at: ancientSqliteFormat,
        })
        .execute();

      const deletedCount = await manager.cleanupOldBaselines(daysOld);

      // Only the genuinely-ancient row is removed; the newer boundary row lives.
      expect(deletedCount).toBe(1);
      expect(await manager.getBaseline("boundary_newer")).not.toBeNull();
      expect(await manager.getBaseline("ancient")).toBeNull();
    });
  });

  describe("Data Integrity", function () {
    it("should preserve violation structure in JSON serialization", async function () {
      const screenId = "test_screen";
      const violations: WcagViolation[] = [
        {
          type: "insufficient-contrast",
          severity: "error",
          criterion: "1.4.3",
          message: "Low contrast",
          element: {
            bounds: { left: 10, top: 20, right: 30, bottom: 40 },
            text: "Sample",
          },
          details: {
            ratio: 3.2,
            required: 4.5,
            textColor: { r: 128, g: 128, b: 128 },
            backgroundColor: { r: 255, g: 255, b: 255 },
          },
          fingerprint: "test123",
        },
      ];

      await manager.saveBaseline(screenId, violations);
      const baseline = await manager.getBaseline(screenId);

      expect(baseline).not.toBeNull();
      expect(baseline!.violations[0]).toEqual(violations[0]);
      expect(baseline!.violations[0].details).toEqual(violations[0].details);
    });

    it("should handle special characters in screen IDs", async function () {
      const screenId = "com.example/MainActivity:Fragment@123";

      await manager.saveBaseline(screenId, []);

      const baseline = await manager.getBaseline(screenId);
      expect(baseline).not.toBeNull();
      expect(baseline!.screenId).toBe(screenId);
    });

    test("getBaseline returns null instead of throwing when a row has corrupt violations_json", async function () {
      const now = new Date().toISOString();
      await testDb
        .insertInto("accessibility_baselines")
        .values({
          screen_id: "corrupt_screen",
          violations_json: "{ this is not valid json",
          created_at: now,
          updated_at: now,
        })
        .execute();

      // A raw SyntaxError must not escape the read boundary (issue #4179).
      const baseline = await manager.getBaseline("corrupt_screen");
      expect(baseline).toBeNull();
    });

    test("listBaselines skips a corrupt row and still returns the intact ones", async function () {
      const now = new Date().toISOString();
      await manager.saveBaseline("good_screen", []);
      await testDb
        .insertInto("accessibility_baselines")
        .values({
          screen_id: "corrupt_screen",
          violations_json: "not json at all",
          created_at: now,
          updated_at: now,
        })
        .execute();

      const baselines = await manager.listBaselines();
      expect(baselines.map((b) => b.screenId)).toEqual(["good_screen"]);
    });

    it("should store and retrieve updated_at timestamp", async function () {
      const screenId = "test_screen";
      const beforeSave = new Date();

      await manager.saveBaseline(screenId, []);

      const baseline = await manager.getBaseline(screenId);
      expect(baseline).not.toBeNull();

      const updatedAt = new Date(baseline!.updatedAt);
      expect(updatedAt.getTime()).toBeGreaterThanOrEqual(beforeSave.getTime() - 1000);
      expect(updatedAt.getTime()).toBeLessThanOrEqual(new Date().getTime() + 1000);
    });
  });
});
