import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import { FamilyMutationPriorReader } from "../../src/server/deviceMutationFamilyPriorReader";
import { SessionDeviceMutationRecording } from "../../src/server/deviceMutationRecording";
import { SessionMutationRecorder } from "../../src/daemon/sessionBroker/mutations/recorder";
import { opaqueIntentKey } from "../../src/daemon/sessionBroker/mutations/types";
import { disposableAppId } from "../../src/features/prototype/disposableApp/disposableAppId";
import { FakeDeviceMutationJournal } from "../fakes/FakeDeviceMutationJournal";
import { FakeTimer } from "../fakes/FakeTimer";

const fallback = (...parts: unknown[]) => ({ kind: "opaque", key: opaqueIntentKey(...parts) });

describe("Orchestration journal intents (#14359)", () => {
  test.each([
    "getAndroid",
    "getApple",
    "startDevice",
    "provisionDevice",
    "killDevice",
    "deleteDevice",
    "barrier",
    "criticalSection",
    "explore",
    "navigateTo",
  ])("%s records nothing itself", (tool) => {
    expect(deviceToolMutations(tool, {}, "android")).toEqual([]);
    expect(deviceToolMutations(tool, {}, "ios")).toEqual([]);
  });

  test("executePlan records only a cleanup that clears app data", () => {
    expect(deviceToolMutations("executePlan", { cleanupAppId: "a.b" }, "android")).toEqual([]);
    expect(
      deviceToolMutations(
        "executePlan",
        { cleanupAppId: "a.b", cleanupClearAppData: true },
        "android",
      ),
    ).toEqual([fallback("clearAppData", "a.b")]);
  });

  test("device resources record when they apply something", () => {
    expect(deviceToolMutations("setDeviceResources", { restore: true }, "android")).toEqual([]);
    expect(
      deviceToolMutations("setDeviceResources", { resources: { animations: false } }, "android"),
    ).toEqual([fallback("setDeviceResources")]);
    expect(deviceToolMutations("reconcileDeviceResources", { resources: {} }, "ios")).toEqual([]);
    expect(
      deviceToolMutations("reconcileDeviceResources", { resources: {}, repair: true }, "ios"),
    ).toEqual([fallback("reconcileDeviceResources")]);
  });

  describe("prototype", () => {
    const show = (spec: unknown) => ({ action: "show", spec });

    test("a plain session show, patch, dismiss or read changes nothing", () => {
      expect(
        deviceToolMutations(
          "prototype",
          show({ id: "p", window: { persistence: "session" } }),
          "android",
        ),
      ).toEqual([]);
      for (const action of ["patch", "dismiss", "status", "inspect", "awaitEvent", "listSaved"]) {
        expect(deviceToolMutations("prototype", { action }, "android")).toEqual([]);
      }
    });

    test.each([
      ["a device-persistent window", { window: { persistence: "device" } }],
      ["a window above apps", { window: { layer: "app" } }],
      ["a storage block", { storage: { version: 1, keys: ["state:a"] } }],
    ])("an Android show with %s leaves device state", (_label, spec) => {
      expect(deviceToolMutations("prototype", show(spec), "android")).toEqual([
        fallback("prototype", "show", "device-state"),
      ]);
    });

    test("an Android save leaves device state, an iOS prototype does not", () => {
      expect(deviceToolMutations("prototype", { action: "save", pin: true }, "android")).toEqual([
        fallback("prototype", "save"),
      ]);
      expect(deviceToolMutations("prototype", { action: "save" }, "ios")).toEqual([]);
      expect(
        deviceToolMutations("prototype", show({ window: { persistence: "device" } }), "ios"),
      ).toEqual([]);
    });

    test.each(["android", "ios"] as const)(
      "a %s disposable-app install records the stamped app id like installApp (#14184)",
      (platform) => {
        const appId = disposableAppId(platform, "news-reader");
        expect(
          deviceToolMutations(
            "prototype",
            { action: "installApp", spec: { id: "p" }, app: { slug: "news-reader" } },
            platform,
          ),
        ).toEqual([{ kind: "installed-app", key: appId }, fallback("installApp", appId)]);
      },
    );

    test("a disposable-app install the handler refuses, list or uninstall records nothing", () => {
      for (const app of [undefined, {}, { slug: "Bad Slug" }, { slug: "a".repeat(49) }]) {
        expect(deviceToolMutations("prototype", { action: "installApp", app }, "ios")).toEqual([]);
      }
      expect(
        deviceToolMutations("prototype", { action: "installApp", app: { slug: "a" } }, "tvos"),
      ).toEqual([]);
      expect(deviceToolMutations("prototype", { action: "listApps" }, "android")).toEqual([]);
      expect(
        deviceToolMutations("prototype", { action: "uninstallApp", expired: true }, "ios"),
      ).toEqual([]);
    });

    test("a show by path is unresolved until the recording layer reads the spec", () => {
      expect(
        deviceToolMutations("prototype", { action: "show", specPath: "/tmp/p.json" }, "android"),
      ).toEqual([fallback("prototype", "show", "unresolved-spec")]);
    });
  });
});

describe("recording a prototype show by path", () => {
  const device: BootedDevice = { deviceId: "emulator-5554", platform: "android", name: "Phone" };
  const scope = { deviceId: device.deviceId, incarnation: "resource", sessionUuid: "session" };

  async function recorded(specs: Record<string, unknown>, specPath: string) {
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    const recording = new SessionDeviceMutationRecording(
      () => new SessionMutationRecorder(journal, scope),
      {
        reader: new FamilyMutationPriorReader([]),
        artifactReader: { appId: async () => undefined },
        specReader: async (path) => specs[path],
      },
    );
    await recording.beforeToolCall("prototype", { action: "show", specPath }, device, {
      sessionUuid: "session",
    });
    return (await journal.list(scope)).map((entry) => entry.key);
  }

  test("a readable ordinary spec records nothing", async () => {
    expect(await recorded({ "/p.json": { id: "p" } }, "/p.json")).toEqual([]);
  });

  test("a readable device-persistent spec records the device-state intent", async () => {
    expect(await recorded({ "/p.json": { window: { persistence: "device" } } }, "/p.json")).toEqual(
      [opaqueIntentKey("prototype", "show", "device-state")],
    );
  });

  test("an unreadable spec stays conservative", async () => {
    expect(await recorded({}, "/missing.json")).toEqual([
      opaqueIntentKey("prototype", "show", "unresolved-spec"),
    ]);
  });
});

describe("recording a disposable-app install (#14184)", () => {
  const device: BootedDevice = { deviceId: "SIM-UDID", platform: "ios", name: "iPhone" };
  const scope = { deviceId: device.deviceId, incarnation: "resource", sessionUuid: "session" };

  test("journals the installed app so release removes it", async () => {
    const journal = new FakeDeviceMutationJournal(new FakeTimer());
    const recording = new SessionDeviceMutationRecording(
      () => new SessionMutationRecorder(journal, scope),
      {
        reader: new FamilyMutationPriorReader([]),
        artifactReader: { appId: async () => undefined },
        specReader: async () => ({ id: "p" }),
      },
    );
    await recording.beforeToolCall(
      "prototype",
      { action: "installApp", specPath: "/p.json", app: { slug: "feedly" } },
      device,
      { sessionUuid: "session" },
    );
    expect((await journal.list(scope)).map(({ kind, key }) => ({ kind, key }))).toEqual([
      { kind: "installed-app", key: disposableAppId("ios", "feedly") },
      { kind: "opaque", key: opaqueIntentKey("installApp", disposableAppId("ios", "feedly")) },
    ]);
  });
});
