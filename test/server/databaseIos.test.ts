import { defaultAdbClientFactory } from "../../src/utils/android-cmdline-tools/AdbClientFactory";
import { FakeAdbClient } from "../fakes/FakeAdbClient";
import { SdkCapabilityQueryError } from "../../src/features/observe/ios/SdkCapabilityQueryError";
import { shapeToolCallError } from "../../src/daemon/shapeToolCallError";
import { afterEach, beforeEach, describe, expect, mock, spyOn, test } from "bun:test";
import { invokeResourceTemplate } from "../helpers/invokeResourceTemplate";
import { registerDatabaseResources } from "../../src/server/databaseResources";
import { registerDatabaseTools } from "../../src/server/databaseTools";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import type {
  IosDatabaseClient,
  IosDatabaseClientResolver,
} from "../../src/server/iosDatabaseClient";
import type { SQLResult } from "../../src/features/database/DatabaseInspector";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { serverConfig } from "../../src/utils/ServerConfig";
import type { BootedDevice, Platform } from "../../src/models";
import { isolateToolRegistry } from "../helpers/withTemporaryTool";
import { toolText } from "../helpers/toolResponse";

/** Awaits a promise that must reject with an Error and returns that Error. */
async function rejectionOf(pending: Promise<unknown>): Promise<Error> {
  try {
    await pending;
  } catch (caught: unknown) {
    if (caught instanceof Error) {
      return caught;
    }
    throw new Error(`expected an Error rejection, got ${String(caught)}`);
  }
  throw new Error("expected the call to reject");
}

isolateToolRegistry();

class AndroidDiscoveryFailsDevices extends FakeDeviceUtils {
  constructor(iosDevice: BootedDevice) {
    super();
    this.setBootedDevices("ios", [iosDevice]);
  }

  override async getBootedDevices(platform: Platform): Promise<BootedDevice[]> {
    if (platform === "android") {
      throw new Error("adb unavailable");
    }
    return super.getBootedDevices(platform);
  }
}

describe("iOS database inspection server integration", function () {
  const iosDevice: BootedDevice = {
    deviceId: "ios-1",
    platform: "ios",
    name: "iPhone 16 Simulator",
  };

  let iosClient: IosDatabaseClientResolver | undefined;
  const unusedIos = async (): Promise<never> => {
    throw new Error("iOS database call not stubbed by this test");
  };
  const useIosClient = (overrides: Partial<IosDatabaseClient>): void => {
    const client: IosDatabaseClient = {
      queryCoreDataForIos: unusedIos,
      executeSQLForIos: unusedIos,
      listDatabasesForIos: unusedIos,
      listTablesForIos: unusedIos,
      getTableDataForIos: unusedIos,
      getTableStructureForIos: unusedIos,
      ...overrides,
    };
    iosClient = () => client;
  };
  const iosOnlyDevices = (): FakeDeviceUtils => {
    const devices = new FakeDeviceUtils();
    devices.setBootedDevices("ios", [iosDevice]);
    return devices;
  };

  beforeEach(function () {
    iosClient = undefined;
    ToolRegistry.clearTools();
    ResourceRegistry.clearResources();
    PlatformDeviceManagerFactory.reset();
    IOSCtrlProxyClient.resetInstances();
    serverConfig.setEmbeddedSdkEnabled(true);
  });

  afterEach(function () {
    ToolRegistry.clearTools();
    ResourceRegistry.clearResources();
    PlatformDeviceManagerFactory.reset();
    IOSCtrlProxyClient.resetInstances();
    serverConfig.setEmbeddedSdkEnabled(false);
  });

  test("Core Data mode forwards only the store, entity and limit and preserves truncation", async () => {
    const calls: unknown[][] = [];
    useIosClient({
      queryCoreDataForIos: async (...args) => {
        calls.push(args);
        return { type: "query", columns: ["name"], rows: [["Apple"]], truncated: true };
      },
    });
    registerDatabaseTools(iosClient);
    const tool = ToolRegistry.getTool("sqlQuery")!;
    const result = await tool.deviceAwareHandler!(iosDevice, {
      appId: "com.example.app",
      store: "Main",
      entity: "Item",
      limit: 2,
    });
    expect(calls).toEqual([["com.example.app", "Main", "Item", 2]]);
    expect(result).toMatchObject({
      structuredContent: { type: "query", rows: [["Apple"]], truncated: true },
    });
    expect(tool.isDeviceReadOnlyCall?.({ store: "Main", entity: "Item" })).toBe(true);
  });

  test("Core Data mode refuses Android before contacting a database bridge", async () => {
    registerDatabaseTools(iosClient);
    const tool = ToolRegistry.getTool("sqlQuery")!;
    await expect(
      tool.deviceAwareHandler!(
        { deviceId: "android-1", platform: "android", name: "Android" },
        {
          appId: "com.example.app",
          store: "Main",
          entity: "Item",
        },
      ),
    ).rejects.toThrow("Core Data queries require an iOS app");
  });

  test.each(["timeout", "not_connected", "sdk_capability_query_failed"] as const)(
    "sqlQuery preserves SDK probe %s through tool error shaping",
    async (code) => {
      const failure = new SdkCapabilityQueryError(code, "SDK probe failed");
      useIosClient({
        executeSQLForIos: async () => {
          throw failure;
        },
      });
      registerDatabaseTools(iosClient);
      const tool = ToolRegistry.getTool("sqlQuery")!;
      const error = await rejectionOf(
        tool.deviceAwareHandler!(iosDevice, {
          appId: "com.example.app",
          databasePath: "app.db",
          query: "SELECT 1",
        }),
      );
      expect(error).toBe(failure);
      const result = shapeToolCallError(error, { toolName: "sqlQuery", source: "MCP" });
      expect(JSON.parse(result.content[0].text)).toEqual({
        success: false,
        error: "SDK probe failed",
        code,
        retryable: true,
      });
    },
  );

  test("sqlQuery executes SELECT on iOS through CtrlProxy and keeps Android response shape", async function () {
    const executeSQLForIos = mock(async () => ({
      type: "query" as const,
      columns: ["id", "payload"],
      rows: [["1", "0xCAFE"]],
    }));
    useIosClient({
      executeSQLForIos,
    });

    registerDatabaseTools(iosClient);
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
      { readOnly: true },
    );
    const payload = JSON.parse(toolText(response));
    expect(payload).toEqual({
      message: "Query returned 1 row(s)",
      type: "query",
      columns: ["id", "payload"],
      rows: [["1", "0xCAFE"]],
    });
  });

  test("sqlQuery leaves an iOS bare database name unchanged", async () => {
    const executeSQLForIos = mock(async (): Promise<SQLResult> => ({ type: "query", rows: [] }));
    useIosClient({ executeSQLForIos });
    registerDatabaseTools(iosClient);
    await ToolRegistry.getTool("sqlQuery")!.deviceAwareHandler!(iosDevice, {
      appId: "com.example.app",
      databasePath: "sessions.db",
      query: "SELECT 1",
    });
    expect(executeSQLForIos).toHaveBeenCalledWith("com.example.app", "sessions.db", "SELECT 1", {
      readOnly: true,
    });
  });

  test.each(["sessions.db", "/data/data/com.example.app/databases/sessions.db"])(
    "Android sqlQuery executes and notifies with the same absolute path: %s",
    async (databasePath) => {
      const device: BootedDevice = { deviceId: "android-test", platform: "android", name: "Fake" };
      const resolvedPath = "/data/data/com.example.app/databases/sessions.db";
      const adb = new FakeAdbClient();
      adb.setCommandResult("shell pidof 'com.example.app'", "4242");
      const command = `shell content call --uri 'content://com.example.app.automobile.database' --method executeSQL --extra databasePath:s:'${resolvedPath}' --extra query:s:'DELETE FROM sessions'`;
      adb.setCommandResult(
        command,
        'Bundle[{success=true, result={"type":"mutation","rowsAffected":1}}]',
      );
      const create = spyOn(defaultAdbClientFactory, "create").mockReturnValue(adb);
      const notify = spyOn(ResourceRegistry, "notifyResourceUpdated").mockResolvedValue(undefined);
      try {
        registerDatabaseTools();
        await ToolRegistry.getTool("sqlQuery")!.deviceAwareHandler!(device, {
          appId: "com.example.app",
          databasePath,
          query: "DELETE FROM sessions",
        });
        expect(adb.getAllCommands()).toContain(command);
        expect(notify).toHaveBeenCalledWith(
          `automobile:devices/android-test/databases/${encodeURIComponent(resolvedPath)}/tables/sessions/data?appId=com.example.app`,
        );
      } finally {
        create.mockRestore();
        notify.mockRestore();
      }
    },
  );

  test("sqlQuery notifies database resources for iOS mutations", async function () {
    const executeSQLForIos = mock(async () => ({
      type: "mutation" as const,
      rowsAffected: 1,
    }));
    useIosClient({
      executeSQLForIos,
    });
    const notifyResourceUpdated = mock(async (_uri: string) => {});
    const originalNotify = ResourceRegistry.notifyResourceUpdated;
    ResourceRegistry.notifyResourceUpdated = notifyResourceUpdated;

    try {
      registerDatabaseTools(iosClient);
      const tool = ToolRegistry.getTool("sqlQuery");
      const response = await tool!.deviceAwareHandler!(iosDevice, {
        appId: "com.example.app",
        databasePath: "/app/Documents/app.db",
        query: "INSERT INTO notes (title) VALUES ('new')",
      });

      const payload = JSON.parse(toolText(response));
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

  const SDK_UNAVAILABLE_PREFIX =
    "database inspection unavailable - embed the AutoMobile SDK and call DatabaseInspector.shared.setEnabled(true)";
  const sdkErrorCases = [
    [
      "mutation_not_authorized",
      "The database is read-only for the inspector. Writes and transaction control (BEGIN/COMMIT/ROLLBACK/SAVEPOINT) require mutation authorization. (in a DEBUG build, configure StorageInspectionConfiguration(allowMutations: true), call DatabaseInspector.shared.authorizeHostMutations(true), and require a launch-scoped mutation token or authorize the current SDK session with DatabaseInspector.shared.authorizeSessionMutations(sessionId:).)",
      false,
    ],
    [
      "unknown_database_path",
      'No registered database at "sessions.sqlite". Use the absolute path reported by the app. List registered paths with the App Databases resource (automobile:devices/{deviceId}/databases?appId={appId}).',
      false,
    ],
    ["multiple_statements_not_supported", "The iOS SDK accepts one SQL statement per call.", false],
    [
      "db_inspection_disabled",
      "Failed to execute SQL on iOS. Ensure the app embeds the AutoMobile SDK in a DEBUG build and calls DatabaseInspector.shared.setEnabled(true).",
      true,
    ],
    [
      "bad_request",
      "The iOS SDK rejected the SQL request as bad_request. Check the database path and SQL query.",
      false,
    ],
    ["unknown_table", "The requested database table was not found (unknown_table).", false],
    [
      "encode_failed",
      "The iOS SDK could not encode the database inspection response (encode_failed).",
      false,
    ],
    [
      "response_too_large",
      "The database inspection response exceeded the SDK size limit (response_too_large).",
      false,
    ],
    [
      "future_sdk_code",
      "The iOS SDK rejected the SQL request with an unrecognized error code: future_sdk_code.",
      false,
    ],
  ] as const;

  test.each(sdkErrorCases)(
    "sqlQuery maps the SDK %s refusal without double-wrapping",
    async (code, expectedMessage, includesSetupAdvice) => {
      useIosClient({
        executeSQLForIos: mock(async () => {
          // SdkDatabaseRouteHandler.error encodes {error: code}; SdkDatabaseClient.requestData
          // prefixes that field with its unavailableMessage when CtrlProxy returns non-2xx.
          throw new Error(`${SDK_UNAVAILABLE_PREFIX}: ${code}`);
        }),
      });

      registerDatabaseTools(iosClient);
      const tool = ToolRegistry.getTool("sqlQuery");
      const thrown = tool!.deviceAwareHandler!(iosDevice, {
        appId: "com.example.app",
        databasePath: "sessions.sqlite",
        query: "BEGIN",
      });
      const error = await rejectionOf(thrown);
      expect(error.message).toBe(expectedMessage);
      expect(error.message.includes("setEnabled(true)")).toBe(includesSetupAdvice);
      expect(error.message).not.toContain("database inspection unavailable");
      if (!includesSetupAdvice) {
        expect(error.message).not.toContain("embed the AutoMobile SDK");
        expect(error.message).not.toContain("database inspection unavailable");
      }
    },
  );

  test.each([
    [
      "transport failure",
      `${SDK_UNAVAILABLE_PREFIX}: The operation couldn’t be completed. (NSURLErrorDomain error -1004.)`,
    ],
    ["HTTP status without route code", `${SDK_UNAVAILABLE_PREFIX}: HTTP 503`],
    ["CtrlProxy connection failure", "Failed to connect to CtrlProxy"],
  ] as const)("sqlQuery keeps setup advice for %s", async (_label, detail) => {
    useIosClient({
      executeSQLForIos: mock(async () => {
        throw new Error(detail);
      }),
    });

    registerDatabaseTools(iosClient);
    const tool = ToolRegistry.getTool("sqlQuery");
    await expect(
      tool!.deviceAwareHandler!(iosDevice, {
        appId: "com.example.app",
        databasePath: "/app/Documents/app.db",
        query: "SELECT 1",
      }),
    ).rejects.toMatchObject({
      message:
        "Failed to execute SQL on iOS. Ensure the app embeds the AutoMobile SDK in a DEBUG build and calls DatabaseInspector.shared.setEnabled(true).",
    });
  });

  test.each([
    ["SELECT * FROM notes", "safe to retry"],
    ["INSERT INTO notes (body) VALUES ('x')", "Do not retry automatically"],
    ["SELECT 1; DELETE FROM notes", "Do not retry automatically"],
  ] as const)(
    "sqlQuery words an unanswered %s by what the host sent",
    async (query, expectedFragment) => {
      useIosClient({
        executeSQLForIos: mock(async () => {
          // The runner's SdkDatabaseError.indeterminateMessage, passed through verbatim.
          throw new Error(
            "database request was sent but no answer arrived in time; the outcome is indeterminate (a write may still have been applied). Do not retry automatically; query the data to confirm first",
          );
        }),
      });

      registerDatabaseTools(iosClient);
      const tool = ToolRegistry.getTool("sqlQuery");
      const error = await rejectionOf(
        tool!.deviceAwareHandler!(iosDevice, {
          appId: "com.example.app",
          databasePath: "/app/Documents/app.db",
          query,
        }),
      );
      expect(error.message).toContain(expectedFragment);
    },
  );

  test.each([
    [
      `${SDK_UNAVAILABLE_PREFIX}: app_not_active`,
      "The target app is not in the foreground; bring it to the foreground and retry.",
    ],
    [
      "Database inspection requires requested appId com.example.app to be the foreground app",
      "The target app is not in the foreground; bring it to the foreground and retry.",
    ],
    [
      "iOS key-value storage requires com.example.app to be the foreground app",
      "The target app is not in the foreground; bring it to the foreground and retry.",
    ],
  ])("sqlQuery reports definite foreground failure: %s", async (detail, message) => {
    useIosClient({
      executeSQLForIos: mock(async () => {
        throw new Error(detail);
      }),
    });
    registerDatabaseTools(iosClient);
    await expect(
      ToolRegistry.getTool("sqlQuery")!.deviceAwareHandler!(iosDevice, {
        appId: "com.example.app",
        databasePath: "/app/Documents/app.db",
        query: "SELECT 1",
      }),
    ).rejects.toMatchObject({ message });
  });

  test("sqlQuery explains the ambiguous unverified SDK capability", async () => {
    useIosClient({
      executeSQLForIos: mock(async () => {
        throw new Error(
          "The foreground iOS app does not expose the AutoMobile SDK capability database.",
        );
      }),
    });
    registerDatabaseTools(iosClient);
    await expect(
      ToolRegistry.getTool("sqlQuery")!.deviceAwareHandler!(iosDevice, {
        appId: "com.example.app",
        databasePath: "/app/Documents/app.db",
        query: "SELECT 1",
      }),
    ).rejects.toMatchObject({
      message:
        "Failed to execute SQL on iOS. The target app is either not in the foreground (bring it to the foreground and retry) or does not embed the AutoMobile SDK in a DEBUG build with DatabaseInspector.shared.setEnabled(true).",
    });
  });

  test.each([
    [
      "Database inspection requires requested appId com.example.app to be the foreground app",
      "The target app is not in the foreground; bring it to the foreground and retry.",
    ],
    [
      "The foreground iOS app does not expose the AutoMobile SDK capability database.",
      "The target app is either not in the foreground (bring it to the foreground and retry) or does not embed the AutoMobile SDK in a DEBUG build with DatabaseInspector.shared.setEnabled(true).",
    ],
    ["unrelated failure", "unrelated failure"],
  ])("database listing preserves its error shape with guidance: %s", async (detail, message) => {
    useIosClient({
      listDatabasesForIos: mock(async () => {
        throw new Error(detail);
      }),
    });
    PlatformDeviceManagerFactory.setInstance(iosOnlyDevices());
    registerDatabaseResources(iosClient);
    const match = ResourceRegistry.matchTemplate(
      "automobile:devices/ios-1/databases?appId=com.example.app",
    )!;
    const content = await invokeResourceTemplate(match);
    expect(JSON.parse(content.text!)).toEqual({
      error: `Failed to list databases: Error: ${message}`,
    });
  });

  test.each([
    ["REPLACE INTO main.\"notes\" (title) VALUES ('new')", "mutation", true],
    [
      "WITH source AS (SELECT 'new' AS title) REPLACE INTO main.`notes` SELECT title FROM source",
      "mutation",
      true,
    ],
    ["PRAGMA user_version = 42", "mutation", true],
    // The query text alone is not authoritative in either direction.
    ["REPLACE INTO notes (title) VALUES ('new')", "query", false],
    ["SELECT * FROM notes", "query", false],
    ["SELECT * FROM notes", "mutation", true],
  ] as const)(
    "sqlQuery invalidation follows the returned %s result type",
    async (query, type, shouldNotify) => {
      const executeSQLForIos = mock(async (): Promise<SQLResult> =>
        type === "mutation"
          ? { type: "mutation", rowsAffected: 1 }
          : { type: "query", columns: ["id"], rows: [["1"]] },
      );
      useIosClient({
        executeSQLForIos,
      });
      const notifyResourceUpdated = mock(async (_uri: string) => {});
      const originalNotify = ResourceRegistry.notifyResourceUpdated;
      ResourceRegistry.notifyResourceUpdated = notifyResourceUpdated;

      try {
        registerDatabaseTools(iosClient);
        const tool = ToolRegistry.getTool("sqlQuery");
        await tool!.deviceAwareHandler!(iosDevice, {
          appId: "com.example.app",
          databasePath: "/app/Documents/app.db",
          query,
        });

        expect(notifyResourceUpdated.mock.calls.length > 0).toBe(shouldNotify);
        if (shouldNotify) {
          expect(notifyResourceUpdated).toHaveBeenCalledWith(
            "automobile:devices/ios-1/databases?appId=com.example.app",
          );
        }
        if (query.includes("REPLACE") && type === "mutation") {
          expect(
            notifyResourceUpdated.mock.calls.some(([uri]) => uri.includes("/tables/notes/data?")),
          ).toBe(true);
        }
      } finally {
        ResourceRegistry.notifyResourceUpdated = originalNotify;
      }
    },
  );

  test("database resources resolve iOS devices through CtrlProxy", async function () {
    const listDatabases = mock(async () => [{ name: "app.db", path: "/app/Documents/app.db" }]);
    useIosClient({
      listDatabasesForIos: listDatabases,
    });
    PlatformDeviceManagerFactory.setInstance(iosOnlyDevices());

    registerDatabaseResources(iosClient);
    const uri = "automobile:devices/ios-1/databases?appId=com.example.app";
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();

    const content = await invokeResourceTemplate(match!);
    const payload = JSON.parse(content.text!);

    expect(listDatabases).toHaveBeenCalledWith("com.example.app");
    expect(payload.databases).toEqual([{ name: "app.db", path: "/app/Documents/app.db" }]);
    expect(payload.totalCount).toBe(1);
  });

  test("database resources still resolve iOS when Android discovery fails", async function () {
    const listDatabases = mock(async () => [{ name: "app.db", path: "/app/Documents/app.db" }]);
    useIosClient({
      listDatabasesForIos: listDatabases,
    });
    PlatformDeviceManagerFactory.setInstance(new AndroidDiscoveryFailsDevices(iosDevice));

    registerDatabaseResources(iosClient);
    const uri = "automobile:devices/ios-1/databases?appId=com.example.app";
    const match = ResourceRegistry.matchTemplate(uri);
    const content = await invokeResourceTemplate(match!);
    const payload = JSON.parse(content.text!);

    expect(listDatabases).toHaveBeenCalledWith("com.example.app");
    expect(payload.databases).toEqual([{ name: "app.db", path: "/app/Documents/app.db" }]);
  });
});
