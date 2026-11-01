import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database, NewMemoryAuditResult } from "../../src/db/types";
import { MemoryAuditResultRepository } from "../../src/db/memoryAuditResultRepository";
import { createTestDatabase } from "./testDbHelper";

describe("MemoryAuditResultRepository", () => {
  let db: Kysely<Database>;

  beforeEach(async () => {
    db = await createTestDatabase();
  });

  afterEach(async () => {
    await db.destroy();
  });

  test("insert persists the audit result on the injected database", async () => {
    const result: NewMemoryAuditResult = {
      device_id: "emulator-5554",
      session_id: "2026-10-18",
      package_name: "com.example",
      tool_name: "tapOn",
      tool_args: "{}",
      timestamp: "2026-10-18T00:00:00.000Z",
      passed: 1,
      pre_java_heap_mb: 1,
      pre_native_heap_mb: 2,
      pre_total_pss_mb: 3,
      post_java_heap_mb: 4,
      post_native_heap_mb: 5,
      post_total_pss_mb: 6,
      java_heap_growth_mb: 3,
      native_heap_growth_mb: 3,
      total_pss_growth_mb: 3,
      gc_count: 0,
      gc_total_duration_ms: 0,
      unreachable_objects_count: null,
      violations_json: "[]",
      diagnostics_json: null,
    };
    await new MemoryAuditResultRepository({ db }).insert(result);
    const rows = await db.selectFrom("memory_audit_results").selectAll().execute();
    expect(rows).toHaveLength(1);
    expect(rows[0]?.tool_name).toBe("tapOn");
    expect(rows[0]?.total_pss_growth_mb).toBe(3);
  });
});
