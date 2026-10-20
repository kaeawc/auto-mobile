import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { putAppFileResultSchema } from "../../src/server/appFileToolOutputSchemas";
import { sqlQueryResultSchema } from "../../src/server/databaseToolOutputSchemas";
import { stageSessionDownloadsResultSchema } from "../../src/server/downloadsFixtureToolOutputSchemas";
import { registerAppFileTools } from "../../src/server/appFileTools";
import { registerDatabaseTools } from "../../src/server/databaseTools";
import { registerDownloadsFixtureTools } from "../../src/server/downloadsFixtureTools";
import type {
  AppFileService,
  LegacyPutAppFileRequest,
  PutAppFileRequest,
} from "../../src/server/appFileService";
import type { PutAppFileBatchResult, PutAppFileResult } from "../../src/server/appFileContract";
import type { DownloadsFixtureService } from "../../src/server/downloadsFixtureService";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { serverConfig } from "../../src/utils/ServerConfig";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";

isolateToolRegistry();

const device: BootedDevice = { deviceId: "fake-device", name: "Fake", platform: "ios" };

type Envelope = { content: Array<{ type: string; text?: string }>; structuredContent: unknown };

function putFileReturning(result: PutAppFileBatchResult): AppFileService["putFile"] {
  function putFile(request: PutAppFileRequest): Promise<PutAppFileBatchResult>;
  function putFile(request: LegacyPutAppFileRequest): Promise<PutAppFileResult>;
  async function putFile(): Promise<PutAppFileBatchResult | PutAppFileResult> {
    return result;
  }
  return putFile;
}

function expectTextEqualsStructured(response: Envelope): void {
  expect(JSON.parse(response.content[0].text!)).toEqual(
    JSON.parse(JSON.stringify(response.structuredContent)),
  );
}

describe("putAppFile, stageSessionDownloads and sqlQuery output schemas (#11830)", () => {
  let restoreExecuteSql = (): void => {};

  beforeEach(() => {
    ToolRegistry.clearTools();
    serverConfig.setEmbeddedSdkEnabled(true);
    IOSCtrlProxyClient.resetInstances();
  });

  afterEach(() => {
    restoreExecuteSql();
    IOSCtrlProxyClient.resetInstances();
    serverConfig.setEmbeddedSdkEnabled(false);
  });

  test("each tool declares its outputSchema", () => {
    registerAppFileTools();
    registerDownloadsFixtureTools();
    registerDatabaseTools();
    expect(ToolRegistry.getTool("putAppFile")?.outputSchema).toBe(putAppFileResultSchema);
    expect(ToolRegistry.getTool("stageSessionDownloads")?.outputSchema).toBe(
      stageSessionDownloadsResultSchema,
    );
    expect(ToolRegistry.getTool("sqlQuery")?.outputSchema).toBe(sqlQueryResultSchema);
  });

  test("putAppFile batch result keeps the text payload and validates structuredContent", async () => {
    registerAppFileTools({
      appFileService: () => ({
        putFile: putFileReturning({
          success: true,
          deviceId: device.deviceId,
          platform: "ios",
          target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
          files: [
            {
              destinationPath: "a.txt",
              byteCount: 1,
              resourceUri: "automobile:devices/x",
              effects: [{ type: "mediaIndex", status: "notRequested" }],
            },
          ],
        }),
        listFiles: async () => {
          throw new Error("unused");
        },
        readFile: async () => {
          throw new Error("unused");
        },
      }),
    });
    const tool = ToolRegistry.getTool("putAppFile")!;
    const response = (await tool.deviceAwareHandler!(device, {
      target: { domain: "app_containers", appId: "com.example.app", container: "documents" },
      files: [{ contentText: "x", destinationPath: "a.txt" }],
    })) as Envelope;
    expectTextEqualsStructured(response);
    expect(putAppFileResultSchema.safeParse(response.structuredContent).success).toBe(true);
    expect(putAppFileResultSchema.safeParse({ success: true }).success).toBe(false);
  });

  test.each(["android", "ios"] as const)(
    "stageSessionDownloads %s result validates structuredContent",
    async (platform) => {
      const service: DownloadsFixtureService = {
        stage: async (request) =>
          platform === "android"
            ? {
                success: true,
                sessionUuid: request.sessionUuid ?? "",
                deviceId: "emulator-5554",
                platform: "android",
                directory: request.directory,
                userId: 0,
                userSource: "primary",
                destinationDirectory: "/storage/emulated/0/Download/run-42",
                reset: false,
                files: [],
              }
            : {
                success: false,
                sessionUuid: request.sessionUuid ?? "",
                deviceId: "sim-1",
                platform: "ios",
                status: "unavailable",
                reason: "Android only",
              },
      };
      registerDownloadsFixtureTools(() => service);
      const response = (await ToolRegistry.getTool("stageSessionDownloads")!.handler({
        sessionUuid: "session-1",
        directory: "run-42",
        files: [{ contentText: "fixture", destinationPath: "fixture.txt" }],
      })) as Envelope;
      expectTextEqualsStructured(response);
      expect(stageSessionDownloadsResultSchema.safeParse(response.structuredContent).success).toBe(
        true,
      );
    },
  );

  test("sqlQuery keeps the text payload and validates structuredContent", async () => {
    const executeSql = spyOn(IOSCtrlProxyClient.prototype, "executeSQLForIos").mockResolvedValue({
      type: "query",
      columns: ["id"],
      rows: [["1"]],
    });
    restoreExecuteSql = () => executeSql.mockRestore();
    registerDatabaseTools();
    const response = (await ToolRegistry.getTool("sqlQuery")!.deviceAwareHandler!(device, {
      appId: "com.example.app",
      databasePath: "/app/Documents/app.db",
      query: "SELECT id FROM notes",
    })) as Envelope;
    expectTextEqualsStructured(response);
    expect(sqlQueryResultSchema.safeParse(response.structuredContent).success).toBe(true);
    expect(sqlQueryResultSchema.safeParse({ type: "query" }).success).toBe(false);
  });
});
