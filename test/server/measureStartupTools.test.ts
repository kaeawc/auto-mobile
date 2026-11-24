import { describe, expect, test } from "bun:test";
import type { PerformanceAuditRecord } from "../../src/db/performanceAuditRepository";
import { ActionableError, type BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import {
  createMeasureStartupHandler,
  measureStartupSchema,
} from "../../src/server/measureStartupTools";
import { measureStartupResultSchema } from "../../src/server/measureStartupToolOutputSchemas";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";

const APP = "dev.jasonpearson.automobile.playground";
const BUNDLE = "dev.jasonpearson.auto-mobile.Playground";
const android: BootedDevice = { name: "Pixel", deviceId: "emulator-5554", platform: "android" };
const ios: BootedDevice = {
  name: "Simulator",
  deviceId: "DD830D62-ACB5-4AEC-BB2A-27EA007B9F27",
  platform: "ios",
};
const physical: BootedDevice = {
  name: "iPhone",
  deviceId: "00008110-001A2D1234567890",
  platform: "ios",
};
const simulatorLog = (
  await Bun.file(
    new URL("../fixtures/ios-startup/log-show-cold-ios26.5.ndjson", import.meta.url),
  ).text()
).replaceAll("com.apple.Preferences", BUNDLE);

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
  const simulatorDevices: BootedDevice[] = [];
  let launched = false;
  const handler = createMeasureStartupHandler({
    createShell: () => adb,
    createIosSimulator: (device) => {
      simulatorDevices.push(device);
      return {
        async executeCommandArgs([command]) {
          if (command === "launch") {
            launched = true;
            return createExecResult(`${BUNDLE}: 13453\n`, "");
          }
          return createExecResult(command === "spawn" && launched ? simulatorLog : "", "");
        },
      };
    },
    timer,
    repository: { recordAudit: async (record) => void records.push(record) },
    // The device's epoch retires once the launches have run, as when it is
    // removed during a settle delay: the run keeps the epoch that produced it.
    resolveDeviceSessionUuid: (deviceId) => {
      if (deviceId === ios.deviceId) {
        return launched ? null : "sim-epoch";
      }
      return deviceId === android.deviceId && adb.getExecutedCommands().length === 0
        ? "epoch-1"
        : null;
    },
  });
  return { handler, records, simulatorDevices };
}

function structured(response: unknown): Record<string, unknown> {
  return (response as { structuredContent: Record<string, unknown> }).structuredContent;
}

describe("measureStartup tool", () => {
  test("measures, stores the run in performance results and returns a schema-valid result", async () => {
    const { handler, records, simulatorDevices } = setup();

    const response = await handler(android, {
      appId: APP,
      activity: ".Main",
      mode: "cold",
      iterations: 2,
      sessionUuid: "session-1",
    });

    const result = structured(response);
    expect(simulatorDevices).toEqual([]);
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
      deviceSessionUuid: "epoch-1",
    });
    expect(JSON.parse(records[0].diagnostics ?? "{}")).toMatchObject({
      kind: "startup",
      mode: "cold",
      ttid: { samples: [900, 900] },
    });
  });

  test("measures and stores an iOS Simulator run using the same result fields", async () => {
    const { handler, records, simulatorDevices } = setup();
    const args = measureStartupSchema.parse({ appId: BUNDLE, mode: "cold", iterations: 1 });
    const result = structured(await handler(ios, { ...args, sessionUuid: "ios-session" }));

    expect(measureStartupResultSchema.safeParse(result).success).toBe(true);
    expect(simulatorDevices).toEqual([ios]);
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({
      deviceId: ios.deviceId,
      sessionId: "ios-session",
      packageName: BUNDLE,
      timestamp: "2026-10-21T12:00:00.500Z",
      passed: true,
      metrics: { timeToFirstFrameMs: 1557, timeToInteractiveMs: null },
      deviceSessionUuid: "sim-epoch",
    });
    expect(JSON.parse(records[0].diagnostics ?? "{}")).toMatchObject({
      kind: "startup",
      mode: "cold",
      ttid: { samples: [1557] },
    });
  });

  test("refuses physical iOS and points to the launch trace template", async () => {
    const { handler, records, simulatorDevices } = setup();
    const result = handler(physical, { appId: BUNDLE, mode: "cold" });

    await expect(result).rejects.toBeInstanceOf(ActionableError);
    await expect(result).rejects.toThrow("Use performanceTrace with the launch template");
    expect(records).toEqual([]);
    expect(simulatorDevices).toEqual([]);
  });

  test("applies the stricter package name rules on Android", async () => {
    const { handler, records } = setup();
    const args = measureStartupSchema.parse({ appId: BUNDLE, mode: "cold" });
    const result = handler(android, args);
    await expect(result).rejects.toBeInstanceOf(ActionableError);
    await expect(result).rejects.toThrow("appId must be an Android package name");
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
