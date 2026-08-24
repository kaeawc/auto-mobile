import { beforeEach, afterEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  PerformanceAuditRepository,
  type PerformanceAuditRecord,
  type PerformanceAuditMetricsRecord,
} from "../../src/db/performanceAuditRepository";
import { ToolCallRepository } from "../../src/db/toolCallRepository";
import { buildPerformanceAuditResponse } from "../../src/server/performanceData";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { registerPerformanceResources } from "../../src/server/performanceResources";

function makeMetrics(
  overrides: Partial<PerformanceAuditMetricsRecord> = {},
): PerformanceAuditMetricsRecord {
  return {
    p50Ms: 8,
    p90Ms: 12,
    p95Ms: 14,
    p99Ms: 18,
    jankCount: 2,
    missedVsyncCount: 1,
    slowUiThreadCount: 0,
    frameDeadlineMissedCount: 3,
    cpuUsagePercent: 45,
    touchLatencyMs: 50,
    ...overrides,
  };
}

function makeRecord(overrides: Partial<PerformanceAuditRecord> = {}): PerformanceAuditRecord {
  return {
    deviceId: "device-1",
    sessionId: "session-1",
    packageName: "com.example.app",
    timestamp: "2024-06-01T12:00:00.000Z",
    passed: true,
    metrics: makeMetrics(),
    diagnostics: null,
    ...overrides,
  };
}

describe("performanceData", () => {
  let db: Kysely<Database>;
  let auditRepo: PerformanceAuditRepository;
  let toolCallRepo: ToolCallRepository;

  beforeEach(async () => {
    db = await createTestDatabase();
    auditRepo = new PerformanceAuditRepository(new FakeTimer(), db);
    toolCallRepo = new ToolCallRepository(db);
  });

  afterEach(async () => {
    await db.destroy();
  });

  describe("buildPerformanceAuditResponse", () => {
    test("returns recorded results with tool calls in the timestamp range", async () => {
      await auditRepo.recordAudit(makeRecord());
      await toolCallRepo.recordToolCall({
        toolName: "swipeOn",
        timestamp: "2024-06-01T12:00:00.000Z",
      });

      const response = await buildPerformanceAuditResponse(
        {},
        { auditRepository: auditRepo, toolCallRepository: toolCallRepo },
      );

      expect(response.results).toHaveLength(1);
      expect(response.results[0].deviceId).toBe("device-1");
      expect(response.toolCalls).toContain("swipeOn");
      expect(response.range).not.toBeNull();
    });

    test("filters by deviceId", async () => {
      await auditRepo.recordAudit(makeRecord({ deviceId: "device-1" }));
      await auditRepo.recordAudit(makeRecord({ deviceId: "device-2" }));

      const response = await buildPerformanceAuditResponse(
        { deviceId: "device-2" },
        { auditRepository: auditRepo, toolCallRepository: toolCallRepo },
      );

      expect(response.results).toHaveLength(1);
      expect(response.results[0].deviceId).toBe("device-2");
    });

    test("returns empty results and a null range when nothing matches", async () => {
      const response = await buildPerformanceAuditResponse(
        { deviceId: "no-such-device" },
        { auditRepository: auditRepo, toolCallRepository: toolCallRepo },
      );

      expect(response.results).toHaveLength(0);
      expect(response.range).toBeNull();
      expect(response.toolCalls).toHaveLength(0);
    });

    test("respects the limit option and reports hasMore/nextOffset", async () => {
      await auditRepo.recordAudit(makeRecord({ sessionId: "session-1" }));
      await auditRepo.recordAudit(makeRecord({ sessionId: "session-2" }));

      const response = await buildPerformanceAuditResponse(
        { limit: 1 },
        { auditRepository: auditRepo, toolCallRepository: toolCallRepo },
      );

      expect(response.results).toHaveLength(1);
      expect(response.hasMore).toBe(true);
      expect(response.nextOffset).toBe(1);
    });
  });

  describe("resource registration", () => {
    afterEach(() => {
      ResourceRegistry.clearResources();
    });

    test("registers the base URI and one RFC 6570 query template", () => {
      registerPerformanceResources();

      expect(ResourceRegistry.getResource("automobile:performance-results")).toBeDefined();

      const templates = ResourceRegistry.getAllTemplates();
      const queryTemplates = templates.filter((t) =>
        t.uriTemplate.startsWith("automobile:performance-results"),
      );
      expect(queryTemplates.map((template) => template.uriTemplate)).toEqual([
        "automobile:performance-results{?startTime,endTime,limit,offset,deviceId}",
      ]);
    });
  });
});
