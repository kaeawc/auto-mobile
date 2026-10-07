import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import { registerDatabaseResources } from "../../src/server/databaseResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import type { BootedDevice } from "../../src/models";

// Issue #10117: getTablesResource / getTableDataResource / getTableStructureResource
// decoded {databasePath} and {table} above their try block, so a malformed
// percent-escape threw a raw URIError out of the handler instead of returning the
// resource's JSON error envelope (a missed sibling of #5734 / #5853).
const MALFORMED_MESSAGE = "Malformed resource URI: a path segment is not valid percent-encoding.";

const device: BootedDevice = { deviceId: "emulator-5554", name: "Pixel", platform: "android" };

class CountingDeviceManager extends FakeDeviceManager {
  bootedLookups = 0;

  async getBootedDevices(...args: Parameters<FakeDeviceManager["getBootedDevices"]>) {
    this.bootedLookups += 1;
    return super.getBootedDevices(...args);
  }
}

describe("database resources: malformed percent-escapes (#10117)", () => {
  let devices: CountingDeviceManager;

  beforeEach(() => {
    ResourceRegistry.clearResources();
    devices = new CountingDeviceManager([], [device]);
    PlatformDeviceManagerFactory.setInstance(devices);
    registerDatabaseResources();
  });

  afterEach(() => {
    ResourceRegistry.clearResources();
    PlatformDeviceManagerFactory.reset();
  });

  async function read(uri: string) {
    const match = ResourceRegistry.matchTemplate(uri);
    expect(match).toBeDefined();
    return match!.template.handler(match!.params);
  }

  const prefix = "automobile:devices/emulator-5554/databases";
  test.each([
    ["tables, bare % in databasePath", `${prefix}/app%.db/tables?appId=com.example`],
    ["tables, %zz in databasePath", `${prefix}/%zz/tables?appId=com.example`],
    ["tables, truncated escape in databasePath", `${prefix}/%E0%A4/tables?appId=com.example`],
    ["data, malformed databasePath", `${prefix}/app%.db/tables/notes/data?appId=com.example`],
    ["data, malformed table", `${prefix}/app.db/tables/no%tes/data?appId=com.example`],
    ["data, both malformed", `${prefix}/%zz/tables/%zz/data?appId=com.example`],
    ["structure, malformed databasePath", `${prefix}/app%.db/tables/notes/structure?appId=a.b`],
    ["structure, malformed table", `${prefix}/app.db/tables/no%tes/structure?appId=a.b`],
  ])("%s resolves to the JSON error envelope before any device lookup", async (_label, uri) => {
    const content = await read(uri);

    expect(content.mimeType).toBe("application/json");
    // The segments cannot be decoded, so the envelope is served on the requested URI.
    expect(content.uri).toBe(uri);
    expect(JSON.parse(content.text ?? "{}")).toEqual({ error: MALFORMED_MESSAGE });
    expect(devices.bootedLookups).toBe(0);
  });

  test("a well-formed percent-encoded databasePath and table still decode and reach the device lookup", async () => {
    const lookup = mock(async () => []);
    PlatformDeviceManagerFactory.setInstance({
      getBootedDevices: lookup,
    } as unknown as ReturnType<typeof PlatformDeviceManagerFactory.getInstance>);

    const content = await read(
      `${prefix}/%2Fdata%2Fapp.db/tables/user%20notes/structure?appId=com.example`,
    );

    expect(lookup).toHaveBeenCalled();
    expect(content.uri).toBe(
      "automobile:devices/emulator-5554/databases/%2Fdata%2Fapp.db/tables/user%20notes/structure?appId=com.example",
    );
    expect(JSON.parse(content.text ?? "{}").error).toContain("Device not found or not booted");
  });
});
