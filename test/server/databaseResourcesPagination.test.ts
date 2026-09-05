import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import type { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SubscribeRequestSchema } from "@modelcontextprotocol/sdk/types.js";
import {
  notifyDatabaseChanged,
  registerDatabaseResources,
} from "../../src/server/databaseResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import type { BootedDevice } from "../../src/models";

// Minimal MCP-server stand-in, matching the pattern in
// resourceRegistryListChanged.test.ts: registerWithServer installs request
// handlers on `server.server`, and notifyResourceUpdated sends through it.
class FakeUnderlyingServer {
  notifications: Array<{ method: string; params?: unknown }> = [];
  handlersBySchema = new Map<unknown, (request: unknown) => Promise<unknown>>();
  onclose?: () => void;
  setRequestHandler(schema: unknown, handler: (request: unknown) => Promise<unknown>): void {
    this.handlersBySchema.set(schema, handler);
  }
  async notification(payload: { method: string; params?: unknown }): Promise<void> {
    this.notifications.push(payload);
  }
}

class FakeMcpServer {
  server = new FakeUnderlyingServer();
}

// Issue #6133: the table-data resource template previously registered a
// literal `?appId={appId}&limit={limit}&offset={offset}` query string, which
// ResourceRegistry.compileUriTemplate compiles into fixed-order, all-required
// captures. That silently broke every URI that omitted limit or offset, or
// supplied them out of order, even though the handler documents both as
// optional. The fix switches to the RFC 6570 `{?appId,limit,offset}` form.
describe("table-data resource template optional pagination (issue #6133)", () => {
  const device: BootedDevice = {
    deviceId: "ios-1",
    platform: "ios",
    name: "iPhone 16 Simulator",
  };

  const base = "automobile:devices/ios-1/databases/%2Fapp%2FDocuments%2Fapp.db/tables/notes/data";

  let originalGetInstance: typeof IOSCtrlProxyClient.getInstance;

  beforeEach(() => {
    ResourceRegistry.clearResources();
    ResourceRegistry.clearServersForTesting();
    PlatformDeviceManagerFactory.reset();
    IOSCtrlProxyClient.resetInstances();
    originalGetInstance = IOSCtrlProxyClient.getInstance;
  });

  afterEach(() => {
    IOSCtrlProxyClient.getInstance = originalGetInstance;
    ResourceRegistry.clearResources();
    ResourceRegistry.clearServersForTesting();
    PlatformDeviceManagerFactory.reset();
    IOSCtrlProxyClient.resetInstances();
  });

  function setupDevice(getTableDataForIos: (...args: unknown[]) => Promise<unknown>): void {
    IOSCtrlProxyClient.getInstance = mock(() => ({
      getTableDataForIos,
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;
    PlatformDeviceManagerFactory.setInstance({
      getBootedDevices: mock(async (platform: string) => (platform === "ios" ? [device] : [])),
    } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);
  }

  test.each([
    ["neither limit nor offset present", `${base}?appId=com.example.app`, 50, 0],
    ["only limit present", `${base}?appId=com.example.app&limit=10`, 10, 0],
    ["only offset present", `${base}?appId=com.example.app&offset=5`, 50, 5],
    ["both present, documented order", `${base}?appId=com.example.app&limit=10&offset=5`, 10, 5],
    ["both present, offset before limit", `${base}?appId=com.example.app&offset=5&limit=10`, 10, 5],
    ["appId after limit/offset", `${base}?limit=10&offset=5&appId=com.example.app`, 10, 5],
  ])("matches and parses params: %s", async (_label, uri, expectedLimit, expectedOffset) => {
    const getTableDataForIos = mock(async () => ({
      columns: ["id"],
      rows: [["1"]],
      total: 1,
    }));
    setupDevice(getTableDataForIos);
    registerDatabaseResources();

    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();

    const content = await match!.template.handler(match!.params);
    const payload = JSON.parse(content.text!);

    expect(payload.limit).toBe(expectedLimit);
    expect(payload.offset).toBe(expectedOffset);
    // The returned uri is always the canonical form (no limit/offset),
    // never the exact requested URI (issue #6188) — notifyDatabaseChanged
    // fires notifyResourceUpdated against this canonical URI, and
    // ResourceRegistry requires an exact subscription match, so a
    // subscriber must be subscribed to this same canonical form to ever
    // receive an update.
    expect(content.uri).toBe(`${base}?appId=com.example.app`);
    expect(getTableDataForIos).toHaveBeenCalledWith(
      "com.example.app",
      "/app/Documents/app.db",
      "notes",
      expectedLimit,
      expectedOffset,
    );
  });

  test("rejects a non-numeric limit with an actionable error instead of NaN", async () => {
    const getTableDataForIos = mock(async () => ({ columns: [], rows: [], total: 0 }));
    setupDevice(getTableDataForIos);
    registerDatabaseResources();

    const uri = `${base}?appId=com.example.app&limit=abc`;
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();

    const content = await match!.template.handler(match!.params);
    const payload = JSON.parse(content.text!);

    expect(payload.error).toContain("Invalid limit");
    expect(getTableDataForIos).not.toHaveBeenCalled();
  });

  test("rejects a negative offset with an actionable error instead of NaN", async () => {
    const getTableDataForIos = mock(async () => ({ columns: [], rows: [], total: 0 }));
    setupDevice(getTableDataForIos);
    registerDatabaseResources();

    const uri = `${base}?appId=com.example.app&offset=-5`;
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();

    const content = await match!.template.handler(match!.params);
    const payload = JSON.parse(content.text!);

    expect(payload.error).toContain("Invalid offset");
    expect(getTableDataForIos).not.toHaveBeenCalled();
  });

  test("rejects a limit outside the safe integer range instead of overflowing", async () => {
    const getTableDataForIos = mock(async () => ({ columns: [], rows: [], total: 0 }));
    setupDevice(getTableDataForIos);
    registerDatabaseResources();

    const uri = `${base}?appId=com.example.app&limit=99999999999999999999999`;
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();

    const content = await match!.template.handler(match!.params);
    const payload = JSON.parse(content.text!);

    expect(payload.error).toContain("Invalid limit");
    expect(getTableDataForIos).not.toHaveBeenCalled();
  });

  // Issue #6188: `{?appId,limit,offset}` makes every query variable optional
  // at the template-match level, including appId — which must stay a
  // required app identity. The handler rejects a missing/empty appId itself.
  test.each([
    ["appId omitted entirely", `${base}?limit=10&offset=5`],
    ["appId present but empty", `${base}?appId=&limit=10&offset=5`],
  ])("rejects table data request when %s", async (_label, uri) => {
    const getTableDataForIos = mock(async () => ({ columns: [], rows: [], total: 0 }));
    setupDevice(getTableDataForIos);
    registerDatabaseResources();

    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();

    const content = await match!.template.handler(match!.params);
    const payload = JSON.parse(content.text!);

    expect(payload.error).toContain("Missing required appId");
    expect(getTableDataForIos).not.toHaveBeenCalled();
  });

  // Issue #6188: ResourceRegistry.extractTemplateParams forwards any query
  // key that isn't a path capture — including a typo like `limt` — instead
  // of silently dropping it, so getTableDataResource must reject unknown
  // keys itself rather than silently falling back to defaults.
  test("rejects an unknown/typo'd query parameter instead of silently defaulting", async () => {
    const getTableDataForIos = mock(async () => ({ columns: [], rows: [], total: 0 }));
    setupDevice(getTableDataForIos);
    registerDatabaseResources();

    const uri = `${base}?appId=com.example.app&limt=10`;
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();
    expect(match!.params.limt).toBe("10");

    const content = await match!.template.handler(match!.params);
    const payload = JSON.parse(content.text!);

    expect(payload.error).toContain("Unknown query parameters");
    expect(payload.error).toContain("limt");
    expect(getTableDataForIos).not.toHaveBeenCalled();
  });

  // Issue #6188: Android's DatabaseInspectorProvider.handleGetTableData
  // parses limit/offset with Kotlin's `toIntOrNull()` (32-bit signed), so a
  // JS-safe-integer value beyond Int32 max would silently fall back to the
  // Android-side default instead of the value the resource response claims.
  test.each([
    ["limit", `${base}?appId=com.example.app&limit=2147483648`],
    ["offset", `${base}?appId=com.example.app&offset=2147483648`],
  ])(
    "rejects an out-of-Int32-range %s instead of silently mismatching Android",
    async (paramName, uri) => {
      const getTableDataForIos = mock(async () => ({ columns: [], rows: [], total: 0 }));
      setupDevice(getTableDataForIos);
      registerDatabaseResources();

      const match = ResourceRegistry.matchTemplate(uri);
      expect(match).toBeDefined();

      const content = await match!.template.handler(match!.params);
      const payload = JSON.parse(content.text!);

      expect(payload.error).toContain(`Invalid ${paramName}`);
      expect(getTableDataForIos).not.toHaveBeenCalled();
    },
  );

  // Issue #6188: extractTemplateParams previously copied every query pair,
  // so a query key colliding with a path-captured param name (deviceId,
  // databasePath, table) silently overrode the path-selected value.
  test("ignores an undeclared query key that collides with a path parameter", async () => {
    const getTableDataForIos = mock(async () => ({
      columns: ["id"],
      rows: [["1"]],
      total: 1,
    }));
    setupDevice(getTableDataForIos);
    registerDatabaseResources();

    const uri = `${base}?appId=com.example.app&deviceId=ios-2`;
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();
    expect(match!.params.deviceId).toBe("ios-1");

    const content = await match!.template.handler(match!.params);
    const payload = JSON.parse(content.text!);

    expect(payload.deviceId).toBe("ios-1");
    expect(getTableDataForIos).toHaveBeenCalledWith(
      "com.example.app",
      "/app/Documents/app.db",
      "notes",
      50,
      0,
    );
  });

  // Issue #6188: notifyDatabaseChanged fires notifyResourceUpdated against the
  // canonical table-data URI (no limit/offset), and ResourceRegistry.
  // notifyResourceUpdated requires an exact subscriptions.has(uri) match. A
  // client that subscribed to the same canonical URI content.uri now always
  // returns (rather than a per-page URI) must actually receive the update
  // after a mutating sqlQuery.
  test("a client subscribed to the canonical content.uri is notified after a mutating change", async () => {
    const getTableDataForIos = mock(async () => ({
      columns: ["id"],
      rows: [["1"]],
      total: 1,
    }));
    setupDevice(getTableDataForIos);
    registerDatabaseResources();

    const uri = `${base}?appId=com.example.app&limit=10&offset=5`;
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();
    const content = await match!.template.handler(match!.params);
    const canonicalUri = `${base}?appId=com.example.app`;
    expect(content.uri).toBe(canonicalUri);

    const server = new FakeMcpServer();
    ResourceRegistry.registerWithServer(server as unknown as McpServer);
    try {
      const subscribeHandler = server.server.handlersBySchema.get(SubscribeRequestSchema);
      expect(subscribeHandler).toBeDefined();
      // Client subscribes to the exact URI it was handed back.
      await subscribeHandler!({ params: { uri: content.uri } });

      await notifyDatabaseChanged("ios-1", "com.example.app", "/app/Documents/app.db", ["notes"]);

      const methods = server.server.notifications.map((n) => n.method);
      const updatedUris = server.server.notifications
        .filter((n) => n.method === "notifications/resources/updated")
        .map((n) => (n.params as { uri: string }).uri);
      expect(methods).toContain("notifications/resources/updated");
      expect(updatedUris).toContain(canonicalUri);
    } finally {
      ResourceRegistry.clearServersForTesting();
    }
  });
});
