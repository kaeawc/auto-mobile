import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { registerDatabaseResources } from "../../src/server/databaseResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import type { BootedDevice } from "../../src/models";

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

  beforeEach(() => {
    ResourceRegistry.clearResources();
    PlatformDeviceManagerFactory.reset();
    IOSCtrlProxyClient.resetInstances();
  });

  afterEach(() => {
    ResourceRegistry.clearResources();
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
});
