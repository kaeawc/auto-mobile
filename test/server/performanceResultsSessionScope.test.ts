import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { createTestDatabase } from "../db/testDbHelper";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  PerformanceAuditRepository,
  type PerformanceAuditRecord,
} from "../../src/db/performanceAuditRepository";
import { ToolCallRepository } from "../../src/db/toolCallRepository";
import { buildPerformanceAuditResponse } from "../../src/server/performanceData";
import { buildPerformanceUri, parsePerformanceParams } from "../../src/server/performanceResources";
import {
  currentDeviceSessionUuid,
  setDeviceSessionUuidResolver,
} from "../../src/utils/deviceIncarnation";

// #17030: a rebooted device reuses its serial, so a deviceId-scoped history mixes
// boots. Audits are stamped with the device epoch and `performance-results`
// accepts an optional `deviceSessionUuid` filter.

function record(overrides: Partial<PerformanceAuditRecord> = {}): PerformanceAuditRecord {
  return {
    deviceId: "emulator-5554",
    sessionId: "2026-11-11",
    packageName: "com.example.app",
    timestamp: "2026-11-11T12:00:00.000Z",
    passed: true,
    metrics: {
      p50Ms: 8,
      p90Ms: 12,
      p95Ms: 14,
      p99Ms: 18,
      jankCount: 0,
      missedVsyncCount: 0,
      slowUiThreadCount: 0,
      frameDeadlineMissedCount: 0,
      cpuUsagePercent: 10,
      touchLatencyMs: 40,
    },
    diagnostics: null,
    ...overrides,
  };
}

describe("performance-results deviceSessionUuid scope (#17030)", () => {
  let db: Kysely<Database>;
  let repositories: {
    auditRepository: PerformanceAuditRepository;
    toolCallRepository: ToolCallRepository;
  };

  beforeAll(async () => {
    db = await createTestDatabase();
    repositories = {
      auditRepository: new PerformanceAuditRepository({ db, timer: new FakeTimer() }),
      toolCallRepository: new ToolCallRepository({ db }),
    };
  });
  afterAll(async () => {
    await db.destroy();
  });
  beforeEach(async () => {
    await db.deleteFrom("performance_audit_results").execute();
    const { auditRepository } = repositories;
    await auditRepository.recordAudit(record({ deviceSessionUuid: "epoch-1" }));
    await auditRepository.recordAudit(
      record({ deviceSessionUuid: "epoch-2", timestamp: "2026-11-11T13:00:00.000Z" }),
    );
    // Recorded before the column existed (or with no live epoch).
    await auditRepository.recordAudit(record({ timestamp: "2026-11-11T11:00:00.000Z" }));
    await auditRepository.recordAudit(
      record({ deviceId: "emulator-5556", deviceSessionUuid: "epoch-other" }),
    );
  });

  const read = (query: Record<string, string>) =>
    buildPerformanceAuditResponse(parsePerformanceParams(query), repositories);

  test("each epoch of a reused serial returns only its own audits", async () => {
    const first = await read({ deviceId: "emulator-5554", deviceSessionUuid: "epoch-1" });
    const second = await read({ deviceId: "emulator-5554", deviceSessionUuid: "epoch-2" });

    expect(first.results.map((row) => row.deviceSessionUuid)).toEqual(["epoch-1"]);
    expect(second.results.map((row) => row.deviceSessionUuid)).toEqual(["epoch-2"]);
  });

  test("an unstamped audit matches no epoch filter", async () => {
    const response = await read({ deviceSessionUuid: "epoch-1" });

    expect(response.results).toHaveLength(1);
    expect(response.results[0].timestamp).toBe("2026-11-11T12:00:00.000Z");
  });

  test("without the filter, history stays device-scoped and includes unstamped audits", async () => {
    const response = await read({ deviceId: "emulator-5554" });

    expect(response.results.map((row) => row.deviceSessionUuid)).toEqual([
      "epoch-2",
      "epoch-1",
      null,
    ]);
  });

  test("a blank filter is ignored and the parsed filter round-trips into the URI", () => {
    expect(parsePerformanceParams({ deviceSessionUuid: "  " }).deviceSessionUuid).toBeUndefined();
    const parsed = parsePerformanceParams({ deviceId: "emulator-5554", deviceSessionUuid: " e1 " });
    expect(parsed.deviceSessionUuid).toBe("e1");
    expect(buildPerformanceUri(parsed)).toBe(
      "automobile:performance-results?deviceId=emulator-5554&deviceSessionUuid=e1",
    );
  });

  test("the epoch lookup answers null until the daemon registers its registry", () => {
    expect(currentDeviceSessionUuid("emulator-5554")).toBeNull();
    setDeviceSessionUuidResolver((deviceId) => (deviceId === "emulator-5554" ? "epoch-1" : null));
    try {
      expect(currentDeviceSessionUuid("emulator-5554")).toBe("epoch-1");
      expect(currentDeviceSessionUuid("emulator-5556")).toBeNull();
    } finally {
      setDeviceSessionUuidResolver(undefined);
    }
  });
});
