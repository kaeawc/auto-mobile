import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { registerStorageResources } from "../../src/server/storageResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";

// storageResources.ts had ZERO test mentions repo-wide (issue #4181, rank 1b).
// Both resource handlers build a URI, look up a booted device, and return a
// JSON envelope. With no booted device the handlers return a "device not
// found" envelope *without* touching any real CtrlProxy client, so the URI
// construction and not-found paths are exercised with only a FakeDeviceManager
// — no DB, no clock, no device, no sockets.
describe("storageResources", () => {
  beforeEach(() => {
    PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager([], []));
    registerStorageResources();
  });

  afterEach(() => {
    PlatformDeviceManagerFactory.setInstance(null);
  });

  function readResource(uri: string) {
    const match = ResourceRegistry.matchTemplate(uri);
    if (!match) {
      throw new Error(`no template matched: ${uri}`);
    }
    return match.template.handler(match.params);
  }

  test("storage-files resource reports device-not-found when no device is booted", async () => {
    const content = await readResource(
      "automobile:devices/emulator-5554/storage/com.example.app/files",
    );
    const body = JSON.parse(content.text ?? "{}");
    expect(content.mimeType).toBe("application/json");
    expect(body.error).toBe("Device not found or not booted: emulator-5554");
  });

  test("storage-entries resource reports device-not-found when no device is booted", async () => {
    const content = await readResource(
      "automobile:devices/emulator-5554/storage/com.example.app/prefs.xml/entries",
    );
    const body = JSON.parse(content.text ?? "{}");
    expect(content.mimeType).toBe("application/json");
    expect(body.error).toBe("Device not found or not booted: emulator-5554");
  });

  test("storage-files resource URI percent-encodes the package segment round-trip", async () => {
    // A package segment containing a character that must be percent-encoded
    // (space -> %20). The handler decodes the incoming segment then rebuilds
    // the URI via encodeURIComponent, so the emitted URI must match the
    // canonical encoded input exactly. Dropping encodeURIComponent from
    // buildFilesUri would emit a raw space and break this round-trip.
    const uri = "automobile:devices/dev1/storage/com.example%20app/files";
    const content = await readResource(uri);
    expect(content.uri).toBe(uri);
  });

  test("storage-entries resource URI percent-encodes package and file segments round-trip", async () => {
    const uri = "automobile:devices/dev1/storage/com.example%20app/settings%20prefs.xml/entries";
    const content = await readResource(uri);
    expect(content.uri).toBe(uri);
  });
});
