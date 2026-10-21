import { beforeEach, describe, expect, test } from "bun:test";
import type { BootedDevice, DeviceSnapshotManifest } from "../../src/models";
import type { DoctorReport } from "../../src/doctor/types";
import { doctorReportSchema } from "../../src/server/doctorToolOutputSchemas";
import { deviceSnapshotResultSchema } from "../../src/server/deviceSnapshotToolOutputSchemas";
import { resetAppLogsResultSchema } from "../../src/server/sessionLogToolOutputSchemas";
import { registerDoctorTools } from "../../src/server/doctorTools";
import { registerSessionLogTools } from "../../src/server/sessionLogTools";
import { registerSnapshotTools } from "../../src/server/snapshotTools";
import {
  resetDeviceSnapshotManagerDependencies,
  setDeviceSnapshotManagerDependencies,
} from "../../src/daemon/deviceSnapshotManager";
import type { SessionLogService } from "../../src/server/sessionLogService";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakeDeviceSnapshotRepository } from "../fakes/FakeDeviceSnapshotRepository";
import { FakeDeviceSnapshotConfigRepository } from "../fakes/FakeDeviceSnapshotConfigRepository";
import { FakeDeviceSnapshotStore } from "../fakes/FakeDeviceSnapshotStore";
import { FakeTimer } from "../fakes/FakeTimer";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "fake-device", name: "Fake", platform: "ios" };

type Envelope = { content: Array<{ type: string; text?: string }>; structuredContent: unknown };

function expectTextEqualsStructured(response: Envelope): void {
  expect(JSON.parse(response.content[0].text!)).toEqual(
    JSON.parse(JSON.stringify(response.structuredContent)),
  );
}

describe("doctor, resetAppLogs and deviceSnapshot output schemas (#11830)", () => {
  beforeEach(() => ToolRegistry.clearTools());

  test("each tool declares its outputSchema", () => {
    registerDoctorTools();
    registerSessionLogTools();
    registerSnapshotTools();
    expect(ToolRegistry.getTool("doctor")?.outputSchema).toBe(doctorReportSchema);
    expect(ToolRegistry.getTool("resetAppLogs")?.outputSchema).toBe(resetAppLogsResultSchema);
    expect(ToolRegistry.getTool("deviceSnapshot")?.outputSchema).toBe(deviceSnapshotResultSchema);
  });

  test("doctor report shape validates and rejects a malformed report", () => {
    const report: DoctorReport = {
      timestamp: "2026-01-01T00:00:00.000Z",
      version: "0.0.0",
      platform: "darwin",
      arch: "arm64",
      system: { checks: [{ name: "bun", status: "pass", message: "ok", value: "1.3.0" }] },
      android: { checks: [{ name: "adb", status: "warn", message: "old", recommendation: "up" }] },
      autoMobile: { checks: [] },
      summary: { total: 2, passed: 1, warnings: 1, failed: 0, skipped: 0 },
      recommendations: ["up"],
    };
    expect(doctorReportSchema.safeParse(report).success).toBe(true);
    expect(doctorReportSchema.safeParse({ ...report, summary: undefined }).success).toBe(false);
  });

  test("resetAppLogs keeps the text payload and validates structuredContent", async () => {
    const service: SessionLogService = {
      collect: async () => {
        throw new Error("not used");
      },
      resetAppLogs: async (request) => ({
        success: true,
        deviceId: request.device.deviceId,
        platform: request.device.platform,
        appId: request.appId,
        container: request.container,
        entries: [
          { path: "a.log", status: "reset" },
          { path: "b.log", status: "failed", reason: "denied" },
        ],
      }),
    };
    registerSessionLogTools(() => service);
    const tool = ToolRegistry.getTool("resetAppLogs")!;
    const response = (await tool.deviceAwareHandler!(
      device,
      tool.schema.parse({ appId: "com.example.app", paths: ["a.log", "b.log"] }),
    )) as Envelope;
    expectTextEqualsStructured(response);
    expect(resetAppLogsResultSchema.safeParse(response.structuredContent).success).toBe(true);
  });

  describe("deviceSnapshot", () => {
    const timer = new FakeTimer();
    let restoreSuccess = true;

    beforeEach(async () => {
      restoreSuccess = true;
      timer.enableAutoAdvance();
      await setDeviceSnapshotManagerDependencies({
        snapshotRepository: new FakeDeviceSnapshotRepository() as never,
        configRepository: new FakeDeviceSnapshotConfigRepository() as never,
        snapshotStore: new FakeDeviceSnapshotStore() as never,
        timer,
        now: () => new Date(timer.now()),
        createCaptureProvider: () => ({
          capture: async (args) => {
            const timestamp = new Date(timer.now()).toISOString();
            const manifest: DeviceSnapshotManifest = {
              snapshotName: args.snapshotName,
              timestamp,
              deviceId: device.deviceId,
              deviceName: device.name,
              platform: "ios",
              snapshotType: "app_data",
              includeAppData: true,
              includeSettings: false,
            };
            return {
              snapshotName: args.snapshotName,
              timestamp,
              snapshotType: "app_data",
              manifest,
            };
          },
        }),
        createRestoreProvider: () => ({
          restore: async (args) => ({
            snapshotType: args.manifest.snapshotType,
            restoredAt: new Date(timer.now()).toISOString(),
            success: restoreSuccess,
            failures: restoreSuccess
              ? []
              : [{ kind: "ios_bundle" as const, bundleId: "com.example", reason: "gone" }],
          }),
        }),
      });
      registerSnapshotTools();
    });

    test.each(["capture", "restore"] as const)(
      "%s keeps the text payload and validates structuredContent",
      async (action) => {
        const tool = ToolRegistry.getTool("deviceSnapshot")!;
        const call = (a: "capture" | "restore") =>
          tool.deviceAwareHandler!(
            device,
            tool.schema.parse({ action: a, snapshotName: "snap-1" }),
          ) as Promise<Envelope>;
        await call("capture");
        restoreSuccess = false;
        const response = await call(action);
        expectTextEqualsStructured(response);
        expect(deviceSnapshotResultSchema.safeParse(response.structuredContent).success).toBe(true);
        resetDeviceSnapshotManagerDependencies();
      },
    );
  });
});
