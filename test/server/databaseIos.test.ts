import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { registerDatabaseResources } from "../../src/server/databaseResources";
import { registerDatabaseTools } from "../../src/server/databaseTools";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { BootedDevice } from "../../src/models";

describe("iOS database inspection server integration", function () {
  const iosDevice: BootedDevice = {
    deviceId: "ios-1",
    platform: "ios",
    name: "iPhone 16 Simulator",
  };

  let originalGetInstance: typeof IOSCtrlProxyClient.getInstance;

  beforeEach(function () {
    ToolRegistry.clearTools();
    ResourceRegistry.clearResources();
    PlatformDeviceManagerFactory.reset();
    IOSCtrlProxyClient.resetInstances();
    serverConfig.setEmbeddedSdkEnabled(true);
    originalGetInstance = IOSCtrlProxyClient.getInstance;
  });

  afterEach(function () {
    IOSCtrlProxyClient.getInstance = originalGetInstance;
    ToolRegistry.clearTools();
    ResourceRegistry.clearResources();
    PlatformDeviceManagerFactory.reset();
    IOSCtrlProxyClient.resetInstances();
    serverConfig.setEmbeddedSdkEnabled(false);
  });

  test("sqlQuery executes SELECT on iOS through CtrlProxy and keeps Android response shape", async function () {
    const executeSQLForIos = mock(async () => ({
      type: "query" as const,
      columns: ["id", "payload"],
      rows: [["1", "0xCAFE"]],
    }));
    IOSCtrlProxyClient.getInstance = mock(() => ({
      executeSQLForIos,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;

    registerDatabaseTools();
    const tool = ToolRegistry.getTool("sqlQuery");
    expect(tool?.deviceAwareHandler).toBeDefined();

    const response = await tool!.deviceAwareHandler!(iosDevice, {
      appId: "com.example.app",
      databasePath: "/app/Documents/app.db",
      query: "SELECT id, payload FROM notes",
    });

    expect(executeSQLForIos).toHaveBeenCalledWith(
      "com.example.app",
      "/app/Documents/app.db",
      "SELECT id, payload FROM notes",
    );
    const payload = JSON.parse(response.content[0].text);
    expect(payload).toEqual({
      message: "Query returned 1 row(s)",
      type: "query",
      columns: ["id", "payload"],
      rows: [["1", "0xCAFE"]],
    });
  });

  test("sqlQuery notifies database resources for iOS mutations", async function () {
    const executeSQLForIos = mock(async () => ({
      type: "mutation" as const,
      rowsAffected: 1,
    }));
    IOSCtrlProxyClient.getInstance = mock(() => ({
      executeSQLForIos,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    const notifyResourceUpdated = mock(async (_uri: string) => {});
    const originalNotify = ResourceRegistry.notifyResourceUpdated;
    ResourceRegistry.notifyResourceUpdated = notifyResourceUpdated;

    try {
      registerDatabaseTools();
      const tool = ToolRegistry.getTool("sqlQuery");
      const response = await tool!.deviceAwareHandler!(iosDevice, {
        appId: "com.example.app",
        databasePath: "/app/Documents/app.db",
        query: "INSERT INTO notes (title) VALUES ('new')",
      });

      const payload = JSON.parse(response.content[0].text);
      expect(payload.type).toBe("mutation");
      expect(payload.rowsAffected).toBe(1);
      expect(notifyResourceUpdated).toHaveBeenCalledWith(
        "automobile:devices/ios-1/databases?appId=com.example.app",
      );
      expect(notifyResourceUpdated).toHaveBeenCalledWith(
        "automobile:devices/ios-1/databases/%2Fapp%2FDocuments%2Fapp.db/tables/notes/data?appId=com.example.app",
      );
    } finally {
      ResourceRegistry.notifyResourceUpdated = originalNotify;
    }
  });

  test("database resources resolve iOS devices through CtrlProxy", async function () {
    const listDatabases = mock(async () => [{ name: "app.db", path: "/app/Documents/app.db" }]);
    IOSCtrlProxyClient.getInstance = mock(() => ({
      listDatabasesForIos: listDatabases,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance({
      getBootedDevices: mock(async () => [iosDevice]),
    } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);

    registerDatabaseResources();
    const uri = "automobile:devices/ios-1/databases?appId=com.example.app";
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();

    const content = await match!.template.handler(match!.params);
    const payload = JSON.parse(content.text!);

    expect(listDatabases).toHaveBeenCalledWith("com.example.app");
    expect(payload.databases).toEqual([{ name: "app.db", path: "/app/Documents/app.db" }]);
    expect(payload.totalCount).toBe(1);
  });

  test("database resources still resolve iOS when Android discovery fails", async function () {
    const listDatabases = mock(async () => [{ name: "app.db", path: "/app/Documents/app.db" }]);
    IOSCtrlProxyClient.getInstance = mock(() => ({
      listDatabasesForIos: listDatabases,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance({
      getBootedDevices: mock(async (platform) => {
        if (platform === "android") {
          throw new Error("adb unavailable");
        }
        return [iosDevice];
      }),
    } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);

    registerDatabaseResources();
    const uri = "automobile:devices/ios-1/databases?appId=com.example.app";
    const match = ResourceRegistry.matchTemplate(uri);
    const content = await match!.template.handler(match!.params);
    const payload = JSON.parse(content.text!);

    expect(listDatabases).toHaveBeenCalledWith("com.example.app");
    expect(payload.databases).toEqual([{ name: "app.db", path: "/app/Documents/app.db" }]);
  });
});
