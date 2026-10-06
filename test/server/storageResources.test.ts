import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";
import {
  registerStorageResources,
  setStorageResourcesAdbClientFactoryForTesting,
} from "../../src/server/storageResources";
import { ResourceRegistry } from "../../src/server/resourceRegistry";
import { PlatformDeviceManagerFactory } from "../../src/utils/factories/PlatformDeviceManagerFactory";
import { FakeDeviceManager } from "../fakes/FakeDeviceManager";
import { AndroidCtrlProxyClient } from "../../src/features/observe/android";
import { IOSCtrlProxyClient } from "../../src/features/observe/ios";
import { ProviderUnavailableError } from "../../src/features/storage/ProviderUnavailableError";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { createExecResult } from "../../src/utils/execResult";
import { readFileSync } from "node:fs";
import type { KeyValueEntry } from "../../src/features/storage/storageTypes";

const ANDROID_SHARED_PREFERENCES_XML = readFileSync(
  new URL("../fixtures/android-shared-preferences.xml", import.meta.url),
  "utf8",
);

// storageResources.ts had ZERO test mentions repo-wide (issue #4181, rank 1b).
// Both resource handlers build a URI, look up a booted device, and return a
// JSON envelope. With no booted device the handlers return a "device not
// found" envelope *without* touching any real CtrlProxy client, so the URI
// construction and not-found paths are exercised with only a FakeDeviceManager
// — no DB, no clock, no device, no sockets.
describe("storageResources", () => {
  const originalGetInstance = AndroidCtrlProxyClient.getInstance;
  const originalIosGetInstance = IOSCtrlProxyClient.getInstance;
  beforeEach(() => {
    PlatformDeviceManagerFactory.setInstance(new FakeDeviceManager([], []));
    registerStorageResources();
  });

  afterEach(() => {
    PlatformDeviceManagerFactory.setInstance(null);
    AndroidCtrlProxyClient.getInstance = originalGetInstance;
    IOSCtrlProxyClient.getInstance = originalIosGetInstance;
    setStorageResourcesAdbClientFactoryForTesting(null);
  });

  function readResource(uri: string) {
    const match = ResourceRegistry.matchTemplate(uri);
    if (!match) {
      throw new Error(`no template matched: ${uri}`);
    }
    return match.template.handler(match.params);
  }

  test.each(["files", "prefs.xml/entries"])(
    "storage %s resource retains typed provider failure fields",
    async (suffix) => {
      PlatformDeviceManagerFactory.setInstance(
        new FakeDeviceManager(
          [],
          [{ deviceId: "emulator-5554", name: "Test", platform: "android" }],
        ),
      );
      AndroidCtrlProxyClient.getInstance = mock(() => ({
        listPreferenceFiles: async () => {
          throw new ProviderUnavailableError(
            "Unknown authority com.example.nondebug.automobile.sharedprefs",
          );
        },
        getPreferenceEntries: async () => {
          throw new ProviderUnavailableError(
            "Unknown authority com.example.nondebug.automobile.sharedprefs",
          );
        },
      })) as unknown as typeof AndroidCtrlProxyClient.getInstance;
      if (suffix.endsWith("entries")) {
        const adb = new FakeAdbExecutor();
        adb.setCommandError("cat shared_prefs/", new Error("run-as is unavailable"));
        setStorageResourcesAdbClientFactoryForTesting({ create: () => adb });
      }
      const content = await readResource(
        `automobile:devices/emulator-5554/storage/com.example.nondebug/${suffix}`,
      );
      const body = JSON.parse(content.text!);
      expect(body.errorCode).toBe("PROVIDER_UNAVAILABLE");
      expect(body.errorReason).toBe("sdk_provider_absent");
    },
  );

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

  test("iOS storage-entries presents SDK redactions without parsing typed values", async () => {
    PlatformDeviceManagerFactory.setInstance(
      new FakeDeviceManager([], [{ deviceId: "ios-sim", name: "Test", platform: "ios" }]),
    );
    IOSCtrlProxyClient.getInstance = mock(() => ({
      getPreferenceEntries: async () => [
        { key: "flagged", type: "STRING", value: "private", redacted: true },
        { key: "legacy", type: "STRING", value: "[REDACTED]" },
        { key: "plain", type: "STRING", value: "visible" },
        { key: "count", type: "INT", value: "not-an-int", redacted: true },
        { key: "enabled", type: "BOOLEAN", value: "not-a-bool", redacted: true },
      ],
    })) as unknown as typeof IOSCtrlProxyClient.getInstance;

    const content = await readResource(
      "automobile:devices/ios-sim/storage/com.example.app/Standard/entries",
    );
    const body = JSON.parse(content.text ?? "{}");
    expect(body.entries).toEqual([
      { key: "flagged", type: "STRING", value: null, redacted: true },
      { key: "legacy", type: "STRING", value: null, redacted: true },
      { key: "plain", type: "STRING", value: "visible" },
      { key: "count", type: "INT", value: null, redacted: true },
      { key: "enabled", type: "BOOLEAN", value: null, redacted: true },
    ]);
  });

  test("storage-entries falls back to run-as and reports its source", async () => {
    PlatformDeviceManagerFactory.setInstance(
      new FakeDeviceManager([], [{ deviceId: "emulator-5554", name: "Test", platform: "android" }]),
    );
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "cat shared_prefs/settings.xml",
      createExecResult(ANDROID_SHARED_PREFERENCES_XML, ""),
    );
    setStorageResourcesAdbClientFactoryForTesting({ create: () => adb });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      getPreferenceEntries: async () => {
        throw new ProviderUnavailableError(
          "Unknown authority com.example.app.automobile.sharedprefs",
        );
      },
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;

    const content = await readResource(
      "automobile:devices/emulator-5554/storage/com.example.app/settings/entries",
    );
    const body = JSON.parse(content.text ?? "{}");
    expect(body.source).toBe("run-as");
    expect(body.entries).toContainEqual({ key: "enabled", type: "BOOLEAN", value: "true" });
    expect(adb.getExecutedCommands()).toHaveLength(1);
  });

  test("storage-entries run-as fallback reads the work profile's copy when the app lives there (#9964)", async () => {
    PlatformDeviceManagerFactory.setInstance(
      new FakeDeviceManager([], [{ deviceId: "emulator-5554", name: "Test", platform: "android" }]),
    );
    const adb = new FakeAdbExecutor();
    adb.setUsers([
      { userId: 0, name: "Owner", flags: 0x4c13, running: true },
      { userId: 10, name: "Work profile", flags: 0x1030, running: true },
    ]);
    adb.setCommandResponse("shell pm list packages --user 0", createExecResult("", ""));
    adb.setCommandResponse(
      "shell pm list packages --user 10",
      createExecResult("package:com.example.app", ""),
    );
    adb.setCommandResponse(
      "cat shared_prefs/settings.xml",
      createExecResult(ANDROID_SHARED_PREFERENCES_XML, ""),
    );
    setStorageResourcesAdbClientFactoryForTesting({ create: () => adb });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      getPreferenceEntries: async () => {
        throw new ProviderUnavailableError(
          "Unknown authority com.example.app.automobile.sharedprefs",
        );
      },
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;

    const content = await readResource(
      "automobile:devices/emulator-5554/storage/com.example.app/settings/entries",
    );

    expect(JSON.parse(content.text ?? "{}").source).toBe("run-as");
    expect(adb.getExecutedCommands().filter((command) => command.includes("run-as"))).toEqual([
      "shell run-as com.example.app --user 10 cat shared_prefs/settings.xml",
    ]);
  });

  test("an app on several non-zero users reports that a resource read cannot choose one (#10021)", async () => {
    PlatformDeviceManagerFactory.setInstance(
      new FakeDeviceManager([], [{ deviceId: "emulator-5554", name: "Test", platform: "android" }]),
    );
    const adb = new FakeAdbExecutor();
    adb.setUsers([
      { userId: 0, name: "Owner", flags: 0x4c13, running: true },
      { userId: 10, name: "Work profile", flags: 0x1030, running: true },
      { userId: 11, name: "Second", flags: 0x1030, running: true },
    ]);
    adb.setCommandResponse("shell pm list packages --user 0", createExecResult("", ""));
    for (const user of [10, 11]) {
      adb.setCommandResponse(
        `shell pm list packages --user ${user}`,
        createExecResult("package:com.example.app", ""),
      );
    }
    setStorageResourcesAdbClientFactoryForTesting({ create: () => adb });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      getPreferenceEntries: async () => {
        throw new ProviderUnavailableError(
          "Unknown authority com.example.app.automobile.sharedprefs",
        );
      },
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;

    const content = await readResource(
      "automobile:devices/emulator-5554/storage/com.example.app/settings/entries",
    );
    const message = String(JSON.parse(content.text ?? "{}").error);

    expect(message).toContain("installed for several users (10, 11)");
    expect(message).toContain("no userId parameter");
    expect(message).not.toContain("Pass userId");
  });

  test("run-as entries match the CtrlProxy encoding for every SharedPreferences type", async () => {
    PlatformDeviceManagerFactory.setInstance(
      new FakeDeviceManager([], [{ deviceId: "emulator-5554", name: "Test", platform: "android" }]),
    );
    const kotlinEncodedEntries: KeyValueEntry[] = [
      { key: "greeting", type: "STRING", value: 'hello "xml" & world' },
      { key: "empty", type: "STRING", value: "" },
      { key: "enabled", type: "BOOLEAN", value: "true" },
      { key: "launch_count", type: "INT", value: "-7" },
      { key: "max_long", type: "LONG", value: "9223372036854775807" },
      { key: "ratio", type: "FLOAT", value: "0.1" },
      { key: "flags", type: "STRING_SET", value: '["first","say \\"hi\\""]' },
      { key: "nullable", type: "UNKNOWN", value: null },
    ];
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse(
      "cat shared_prefs/settings.xml",
      createExecResult(ANDROID_SHARED_PREFERENCES_XML, ""),
    );
    setStorageResourcesAdbClientFactoryForTesting({ create: () => adb });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      getPreferenceEntries: async (packageName: string, _fileName: string) => {
        if (packageName === "com.example.runas") {
          throw new ProviderUnavailableError("SharedPreferences provider is unavailable");
        }
        return kotlinEncodedEntries;
      },
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;

    const ctrlProxyContent = await readResource(
      "automobile:devices/emulator-5554/storage/com.example.ctrlproxy/settings/entries",
    );
    const runAsContent = await readResource(
      "automobile:devices/emulator-5554/storage/com.example.runas/settings/entries",
    );
    const ctrlProxyBody = JSON.parse(ctrlProxyContent.text ?? "{}");
    const runAsBody = JSON.parse(runAsContent.text ?? "{}");
    expect(ctrlProxyBody.entries).toEqual(kotlinEncodedEntries);
    expect(runAsBody.entries).toEqual(ctrlProxyBody.entries);
    expect(ctrlProxyBody.source).toBe("ctrlproxy");
    expect(runAsBody.source).toBe("run-as");
  });

  test("storage-entries reports CtrlProxy as the source when its read succeeds", async () => {
    PlatformDeviceManagerFactory.setInstance(
      new FakeDeviceManager([], [{ deviceId: "emulator-5554", name: "Test", platform: "android" }]),
    );
    const entries = [{ key: "enabled", type: "BOOLEAN" as const, value: "true" }];
    const adb = new FakeAdbExecutor();
    setStorageResourcesAdbClientFactoryForTesting({ create: () => adb });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      getPreferenceEntries: async () => entries,
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;

    const content = await readResource(
      "automobile:devices/emulator-5554/storage/com.example.app/settings/entries",
    );
    const body = JSON.parse(content.text ?? "{}");
    expect(body.source).toBe("ctrlproxy");
    expect(body.entries).toEqual(entries);
    expect(adb.getExecutedCommands()).toHaveLength(0);
  });

  test("storage-entries surfaces non-availability CtrlProxy errors without run-as", async () => {
    PlatformDeviceManagerFactory.setInstance(
      new FakeDeviceManager([], [{ deviceId: "emulator-5554", name: "Test", platform: "android" }]),
    );
    const adb = new FakeAdbExecutor();
    setStorageResourcesAdbClientFactoryForTesting({ create: () => adb });
    const failure = new Error("invalid preference request");
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      getPreferenceEntries: async () => {
        throw failure;
      },
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;

    const content = await readResource(
      "automobile:devices/emulator-5554/storage/com.example.app/settings/entries",
    );
    const body = JSON.parse(content.text ?? "{}");
    expect(body.error).toContain(failure.message);
    expect(adb.getExecutedCommands()).toHaveLength(0);
  });

  test.each(["Failed to connect to accessibility service", "WebSocket not connected"])(
    "storage-entries falls back for CtrlProxy transport error %s",
    async (message) => {
      PlatformDeviceManagerFactory.setInstance(
        new FakeDeviceManager(
          [],
          [{ deviceId: "emulator-5554", name: "Test", platform: "android" }],
        ),
      );
      const adb = new FakeAdbExecutor();
      adb.setCommandResponse(
        "cat shared_prefs/settings.xml",
        createExecResult(ANDROID_SHARED_PREFERENCES_XML, ""),
      );
      setStorageResourcesAdbClientFactoryForTesting({ create: () => adb });
      AndroidCtrlProxyClient.getInstance = mock(() => ({
        getPreferenceEntries: async () => {
          throw new Error(message);
        },
      })) as unknown as typeof AndroidCtrlProxyClient.getInstance;

      const content = await readResource(
        "automobile:devices/emulator-5554/storage/com.example.app/settings/entries",
      );
      expect(JSON.parse(content.text ?? "{}").source).toBe("run-as");
      expect(adb.getExecutedCommands()).toHaveLength(1);
    },
  );

  test("storage-entries reports both failures when run-as also fails", async () => {
    PlatformDeviceManagerFactory.setInstance(
      new FakeDeviceManager([], [{ deviceId: "emulator-5554", name: "Test", platform: "android" }]),
    );
    const adb = new FakeAdbExecutor();
    adb.setCommandError("cat shared_prefs/settings.xml", new Error("run-as permission denied"));
    setStorageResourcesAdbClientFactoryForTesting({ create: () => adb });
    AndroidCtrlProxyClient.getInstance = mock(() => ({
      getPreferenceEntries: async () => {
        throw new ProviderUnavailableError("CtrlProxy provider is unavailable");
      },
    })) as unknown as typeof AndroidCtrlProxyClient.getInstance;

    const content = await readResource(
      "automobile:devices/emulator-5554/storage/com.example.app/settings/entries",
    );
    const body = JSON.parse(content.text ?? "{}");
    expect(body.error).toContain("CtrlProxy: CtrlProxy provider is unavailable");
    expect(body.error).toContain("run-as: Failed to read Android SharedPreferences");
    expect(body.errorCode).toBe("PROVIDER_UNAVAILABLE");
    expect(body.errorReason).toBe("sdk_provider_absent");
    expect(adb.getExecutedCommands()).toHaveLength(1);
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

  test("storage-files resource returns a JSON envelope for a malformed percent-encoded segment (not a raw throw)", async () => {
    // A host-defined package segment with a literal `%` that is not valid
    // percent-encoding must yield a typed JSON diagnostic served on the
    // originally-requested URI, not a URIError that escapes the handler and
    // ResourceRegistry (cf. #5686 for query params; issue #5734 for path params).
    const uri = "automobile:devices/emulator-5554/storage/wei%rd/files";
    const content = await readResource(uri);
    expect(content.mimeType).toBe("application/json");
    expect(content.uri).toBe(uri);
    const body = JSON.parse(content.text ?? "{}");
    expect(String(body.error)).toContain("percent-encoding");
  });

  test("storage-entries resource returns a JSON envelope for a malformed percent-encoded segment (not a raw throw)", async () => {
    const uri = "automobile:devices/emulator-5554/storage/com.example.app/wei%rd/entries";
    const content = await readResource(uri);
    expect(content.mimeType).toBe("application/json");
    expect(content.uri).toBe(uri);
    const body = JSON.parse(content.text ?? "{}");
    expect(String(body.error)).toContain("percent-encoding");
  });
});
