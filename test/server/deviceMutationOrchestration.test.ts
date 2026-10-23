import { describe, expect, test } from "bun:test";
import type { BootedDevice } from "../../src/models";
import { deviceToolMutations } from "../../src/server/deviceMutationAdapters";
import { FamilyMutationPriorReader } from "../../src/server/deviceMutationFamilyPriorReader";
import { SessionDeviceMutationRecording } from "../../src/server/deviceMutationRecording";
import { SessionMutationRecorder } from "../../src/daemon/sessionBroker/mutations/recorder";
import { opaqueIntentKey } from "../../src/daemon/sessionBroker/mutations/types";
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
      new FamilyMutationPriorReader([]),
      { appId: async () => undefined },
      async (path) => specs[path],
    );
    await recording.beforeToolCall("prototype", { action: "show", specPath }, device, "session");
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
