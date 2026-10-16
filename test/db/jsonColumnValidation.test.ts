import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { Kysely } from "kysely";
import type { Database } from "../../src/db/types";
import { DeviceSnapshotRepository } from "../../src/db/deviceSnapshotRepository";
import { FailureAnalyticsRepository } from "../../src/db/failureAnalyticsRepository";
import { parseStackTrace } from "../../src/features/observe/android/AndroidAppEventRecorder";
import { decodeStackTrace } from "../../src/db/failureAggregateJson";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { createTestDatabase } from "./testDbHelper";

describe("behaviour-driving JSON columns are validated on read (#11859)", () => {
  let db: Kysely<Database>;
  let warn: ReturnType<typeof spyOn>;

  beforeEach(async () => {
    db = await createTestDatabase();
    warn = spyOn(logger, "warn").mockImplementation(() => {});
  });

  afterEach(async () => {
    warn.mockRestore();
    await db.destroy();
  });

  test("device snapshot with a wrong-shaped manifest reads as null and logs", async () => {
    const now = "2024-01-01T00:00:00.000Z";
    await db
      .insertInto("device_snapshots")
      .values({
        snapshot_name: "bad",
        device_id: "emulator-5554",
        device_name: "Pixel_6",
        platform: "android",
        snapshot_type: "vm",
        include_app_data: 0,
        include_settings: 0,
        created_at: now,
        last_accessed_at: now,
        size_bytes: 1,
        manifest_json: JSON.stringify({ snapshotName: 42 }),
      } as never)
      .execute();

    expect(await new DeviceSnapshotRepository(db).getSnapshot("bad")).toBeNull();
    expect(warn).toHaveBeenCalled();
    expect(String(warn.mock.calls[0]?.[0])).toContain("failed validation");
  });

  test("failure group with wrong-shaped aggregates falls back and logs", async () => {
    const timer = new FakeTimer();
    timer.setCurrentTime(1000000);
    const repo = new FailureAnalyticsRepository(timer, db);
    await repo.recordFailure({
      type: "crash",
      signature: "sig",
      title: "t",
      message: "m",
      severity: "critical",
      occurrence: { deviceModel: "Pixel", os: "14", appVersion: "1", sessionId: "s" },
    });
    await db
      .updateTable("failure_groups")
      .set({
        stack_trace_json: JSON.stringify({ not: "an array" }),
        tool_call_info_json: JSON.stringify({ toolName: 7 }),
      })
      .execute();

    const [group] = await repo.getFailureGroups();
    expect(group.stackTraceElements).toEqual([]);
    expect(group.toolCallInfo).toBeNull();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  test("real producer stack trace with a frame lacking a line number round-trips", () => {
    const frames = parseStackTrace(
      "at com.example.app.Foo.bar(Foo.kt)\nat com.example.app.Foo.baz(Foo.kt:12)",
      "com.example.app",
    );
    const decoded = decodeStackTrace(JSON.stringify(frames));
    expect(decoded).toHaveLength(2);
    expect(decoded[0].lineNumber).toBeNull();
    expect(decoded[1].lineNumber).toBe(12);
    expect(warn).not.toHaveBeenCalled();
  });
});
