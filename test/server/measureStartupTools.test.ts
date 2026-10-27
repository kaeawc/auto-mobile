import { describe, expect, test } from "bun:test";
import type { PerformanceAuditRecord } from "../../src/db/performanceAuditRepository";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import {
  createMeasureStartupHandler,
  measureStartupSchema,
} from "../../src/server/measureStartupTools";
import { measureStartupResultSchema } from "../../src/server/measureStartupToolOutputSchemas";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

const APP = "dev.jasonpearson.automobile.playground";
const android: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };
const ios: BootedDevice = { name: "iPhone", deviceId: "sim-1", platform: "ios" };

function setup() {
  const adb = new FakeAdbExecutor();
  adb.setDeviceTimestampMs(1729500000000);
  adb.setCommandResponse(
    "am start -W",
    createExecResult(
      `Status: ok\nLaunchState: COLD\nActivity: ${APP}/.Main\nTotalTime: 900\nWaitTime: 910\nComplete\n`,
      "",
    ),
  );
  const timer = new FakeTimer();
  timer.enableAutoAdvance();
  timer.setCurrentTime(Date.parse("2026-10-21T12:00:00.000Z"));
  const records: PerformanceAuditRecord[] = [];
  const handler = createMeasureStartupHandler({
    createShell: () => adb,
    timer,
    repository: { recordAudit: async (record) => void records.push(record) },
  });
  return { handler, records };
}

function structured(response: unknown): Record<string, unknown> {
  return (response as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe("measureStartup tool", () => {
  test("measures, stores the run in performance results and returns a schema-valid result", async () => {
    const { handler, records } = setup();

    const response = await handler(android, {
      appId: APP,
      activity: ".Main",
      mode: "cold",
      iterations: 2,
      sessionUuid: "session-1",
    });

    const result = structured(response);
    expect(measureStartupResultSchema.safeParse(result).success).toBe(true);
    expect(result.message).toBe(`cold start of ${APP}/.Main over 2 launches: TTID p50 900 ms`);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      deviceId: "emulator-5554",
      sessionId: "session-1",
      packageName: APP,
      // Two iterations of 500 ms pre-launch idle and 1500 ms settle on the fake clock.
      timestamp: "2026-10-21T12:00:04.000Z",
      passed: true,
      metrics: { timeToFirstFrameMs: 900, timeToInteractiveMs: null },
    });
    expect(JSON.parse(records[0].diagnostics ?? "{}")).toMatchObject({
      kind: "startup",
      mode: "cold",
      ttid: { samples: [900, 900] },
    });
  });

  test("refuses iOS devices", async () => {
    const { handler, records } = setup();

    await expect(handler(ios, { appId: APP, mode: "cold" })).rejects.toThrow(
      "only supported on Android",
    );
    expect(records).toEqual([]);
  });

  test("schema caps iterations and rejects undeclared arguments", () => {
    expect(
      measureStartupSchema.safeParse({ appId: APP, mode: "cold", iterations: 51 }).success,
    ).toBe(false);
    expect(measureStartupSchema.safeParse({ appId: APP, mode: "cold", extra: true }).success).toBe(
      false,
    );
    expect(measureStartupSchema.safeParse({ appId: "not a package", mode: "cold" }).success).toBe(
      false,
    );
    expect(
      measureStartupSchema.safeParse({ appId: APP, mode: "hot", compilation: "speed" }).success,
    ).toBe(true);
  });
});
