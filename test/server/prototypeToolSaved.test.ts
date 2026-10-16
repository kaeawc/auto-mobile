import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import {
  PROTOTYPE_SAVED_CAPABILITY,
  SAVED_PROTOTYPE_ERROR_CODES,
} from "../../src/features/observe/android/ctrlProxyProtocol";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import {
  prototypeOutputSchema,
  prototypeSchema,
  registerPrototypeTools,
  isPrototypeReadAction,
} from "../../src/server/prototypeTools";
import { savedPrototypeErrorMessages } from "../../src/server/prototypeSavedActions";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakePrototypeAgentClient } from "../fakes/FakePrototypeAgentClient";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const android: BootedDevice = { deviceId: "saved-android", platform: "android", name: "Fake" };
const ios: BootedDevice = { deviceId: "saved-ios", platform: "ios", name: "Fake" };
const spec = {
  id: "demo",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "text" as const, text: "Hello" },
};
const assets = [{ id: "logo", path: "/img/logo.png" }];
const png = Buffer.concat([
  Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
  Buffer.alloc(4),
]);
const saved = { id: "demo", slug: "demo", replaced: false };

describe("prototype saved actions", () => {
  let proxy: FakeCtrlProxy;
  let adb: FakeAdbExecutor;
  let agent: FakePrototypeAgentClient;
  let reader: FakePrototypeAssetFileReader;
  let restore: () => void;
  let dispose: () => void;
  let connected: boolean;
  function setup() {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    proxy = new FakeCtrlProxy(timer);
    proxy.setSupportedCommands([PROTOTYPE_SAVED_CAPABILITY]);
    proxy.setSaveResult({ success: true, saved });
    agent = new FakePrototypeAgentClient();
    adb = new FakeAdbExecutor();
    connected = true;
    reader = new FakePrototypeAssetFileReader().addFile("/img/logo.png", png);
    dispose = registerPrototypeTools({
      clientFactory: () => proxy,
      adbFactory: new FakeAdbClientFactory(adb),
      agentConnections: { get: () => (connected ? agent : undefined) },
      store: new InMemoryPrototypeStatusStore(timer),
      timer,
      clock: timer,
      assetFileReader: reader,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
      lifecycle: {
        subscribeSessionRelease: () => () => {},
        subscribeDeviceRemoval: () => () => {},
        subscribeDeviceUnbound: () => () => {},
      },
    });
  }
  beforeAll(async () => {
    setup();
    try {
      await call({ action: "save", spec });
      await call({ action: "listSaved" });
      await call({ action: "deleteSaved", id: "demo" });
      await call({ action: "show", spec });
    } finally {
      dispose();
      restore();
    }
  });
  beforeEach(setup);
  afterEach(() => {
    dispose();
    restore();
  });
  async function call(input: unknown, device = android, signal?: AbortSignal) {
    const result = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(
      device,
      input,
      undefined,
      signal,
    );
    return prototypeOutputSchema.parse(result.structuredContent);
  }
  const save = (extra: Record<string, unknown> = {}) => call({ action: "save", spec, ...extra });

  test.each([false, true])("save replacement=%s and default label", async (replaced) => {
    proxy.setSaveResult({ success: true, saved: { ...saved, replaced } });
    expect(await save()).toEqual({ success: true, saved: { ...saved, replaced } });
    expect(proxy.saveRequests).toEqual([{ spec, label: "demo" }]);
    expect(await call({ action: "status" })).toMatchObject({ success: true, prototypes: [] });
  });
  test("save without pin never asks to pin", async () => {
    expect(await save()).toEqual({ success: true, saved });
    expect(proxy.pinRequests).toEqual([]);
  });
  test("pin requested stays pending and sends the icon", async () => {
    proxy.setPinResult({ success: true, pin: { id: "demo", status: "requested" } });
    const output = await save({ pin: true, icon: "logo", assets });
    expect(output).toMatchObject({ success: true, saved, pinned: "pending" });
    expect(output.warning).toContain("only once it is accepted");
    expect(output.warning).not.toContain("autoConfirm");
    expect(proxy.pinRequests).toEqual([{ id: "demo", icon: "logo" }]);
  });
  test("autoConfirm adds the not-implemented reminder", async () => {
    proxy.setPinResult({ success: true, pin: { id: "demo", status: "requested" } });
    expect((await save({ pin: true, autoConfirm: true })).warning).toContain("#12266");
  });
  test("already pinned reports pinned", async () => {
    proxy.setPinResult({ success: true, pin: { id: "demo", status: "already_pinned" } });
    expect(await save({ pin: true })).toEqual({ success: true, saved, pinned: "pinned" });
  });
  test("unsupported launcher keeps the save", async () => {
    proxy.setPinResult({ success: false, errorCode: "pin_unsupported" });
    const output = await save({ pin: true });
    expect(output).toMatchObject({ success: true, saved, pinned: "unsupported" });
    expect(output.warning).toContain(savedPrototypeErrorMessages.pin_unsupported);
  });
  test.each(["device_locked", "pin_failed"] as const)(
    "pin %s fails but reports the save",
    async (code) => {
      proxy.setPinResult({ success: false, errorCode: code });
      expect(await save({ pin: true })).toEqual({
        success: false,
        saved,
        errorCode: code,
        error: `Saved, but pinning failed. ${savedPrototypeErrorMessages[code]}`,
      });
    },
  );
  test("a failed save never requests a pin", async () => {
    proxy.setSaveResult({ success: false, errorCode: "storage_failure" });
    expect((await save({ pin: true })).success).toBe(false);
    expect(proxy.pinRequests).toEqual([]);
  });
  test("save sends host-expanded component nodes", async () => {
    expect(
      await save({
        spec: {
          ...spec,
          components: { greeting: { root: { type: "text", text: "Hello {props.name}" } } },
          root: { type: "use", component: "greeting", props: { name: "Ada" } },
        },
      }),
    ).toMatchObject({ success: true });
    expect(proxy.saveRequests).toEqual([
      { spec: { ...spec, root: { type: "text", text: "Hello Ada" } }, label: "demo" },
    ]);
  });
  test.each([false, true])(
    "cancelled save afterUpload=%s sends no save request",
    async (afterUpload) => {
      const controller = new AbortController();
      if (afterUpload) {
        const put = proxy.requestPutPrototypeAsset.bind(proxy);
        proxy.requestPutPrototypeAsset = async (...args) => {
          const result = await put(...args);
          controller.abort(new Error("caller stopped"));
          return result;
        };
      } else {
        controller.abort();
      }
      const output = await call(
        { action: "save", spec, ...(afterUpload ? { assets } : {}) },
        android,
        controller.signal,
      );
      expect(output.success).toBe(false);
      expect(output.error).toContain("the request was cancelled");
      expect(proxy.getPrototypeAssetHistory()).toHaveLength(afterUpload ? 1 : 0);
      expect(proxy.saveRequests).toEqual([]);
    },
  );
  test("label and icon forwarded after assets upload", async () => {
    const order: string[] = [];
    const put = proxy.requestPutPrototypeAsset.bind(proxy);
    const request = proxy.requestSavePrototype.bind(proxy);
    proxy.requestPutPrototypeAsset = async (...args) => {
      order.push("upload");
      return put(...args);
    };
    proxy.requestSavePrototype = async (...args) => {
      order.push("save");
      return request(...args);
    };
    expect(await save({ label: "My demo", icon: "logo", assets })).toMatchObject({
      success: true,
      saved,
      uploadedAssets: [{ id: "logo", bytes: 12, mimeType: "image/png" }],
    });
    expect(order).toEqual(["upload", "save"]);
    expect(proxy.saveRequests).toEqual([{ spec, label: "My demo", icon: "logo" }]);
  });
  test("save refuses element anchors before reading or uploading assets", async () => {
    const anchored = {
      ...spec,
      root: {
        type: "text" as const,
        text: "Hello",
        anchor: {
          type: "element" as const,
          selector: { text: "Continue" },
          alignment: "cover" as const,
        },
      },
    };
    expect(
      prototypeSchema.safeParse({ action: "save", spec: anchored, assets, icon: "logo" }).success,
    ).toBe(true);
    const output = await save({ spec: anchored, assets, icon: "logo" });
    expect(output).toMatchObject({ success: false, errorCode: "invalid_spec" });
    expect(output.error?.toLowerCase()).toContain("element anchors");
    expect(output.error).toContain("bounds");
    expect(output.error?.toLowerCase()).toContain("nothing was uploaded or saved");
    expect(reader.reads).toEqual([]);
    expect(proxy.getPrototypeAssetHistory()).toEqual([]);
    expect(proxy.saveRequests).toEqual([]);
    expect(output.uploadedAssets).toBeUndefined();
  });
  test("save accepts bounds anchors", async () => {
    const anchored = {
      ...spec,
      root: {
        type: "text" as const,
        text: "Hello",
        anchor: { type: "bounds" as const, bounds: { x: 1, y: 2, width: 30, height: 40 } },
      },
    };
    expect(await save({ spec: anchored })).toMatchObject({ success: true });
    expect(proxy.saveRequests).toHaveLength(1);
  });
  test("upload failure ends save", async () => {
    reader.addFile("/img/second.png", png);
    const put = proxy.requestPutPrototypeAsset.bind(proxy);
    proxy.requestPutPrototypeAsset = async (...args) => {
      if (args[0].id === "second") {
        throw new Error("upload failed");
      }
      return put(...args);
    };
    const output = await save({ assets: [...assets, { id: "second", path: "/img/second.png" }] });
    expect(output.success).toBe(false);
    expect(output.error).toContain("The prototype was not saved.");
    expect(output.error).not.toContain("The new spec was not sent");
    expect(output.uploadedAssets).toEqual([{ id: "logo", bytes: 12, mimeType: "image/png" }]);
    expect(proxy.saveRequests).toEqual([]);
  });
  test.each(["save", "listSaved", "deleteSaved"] as const)(
    "%s capability absent makes no request",
    async (action) => {
      proxy.setSupportedCommands([]);
      expect(
        await call({
          action,
          ...(action === "save"
            ? { spec, assets }
            : action === "deleteSaved"
              ? { id: "demo" }
              : {}),
        }),
      ).toMatchObject({ success: false, errorCode: "unsupported_capability" });
      expect(reader.reads).toEqual([]);
      expect(proxy.getPrototypeAssetHistory()).toEqual([]);
      expect(proxy.saveRequests).toEqual([]);
      expect(proxy.deleteRequests).toEqual([]);
      expect(proxy.listCalls).toBe(0);
    },
  );
  test.each(SAVED_PROTOTYPE_ERROR_CODES)("store error %s is actionable", async (errorCode) => {
    proxy.setSaveResult({ success: false, errorCode, error: "device detail" });
    const message = savedPrototypeErrorMessages[errorCode];
    expect(message.length).toBeGreaterThan(0);
    expect(await save()).toEqual({ success: false, errorCode, error: `${message} device detail` });
    expect(new Set(Object.values(savedPrototypeErrorMessages)).size).toBe(
      SAVED_PROTOTYPE_ERROR_CODES.length,
    );
  });
  test("unrecognised failure preserves device text without a code", async () => {
    // A future wire code is intentionally not part of the typed protocol yet.
    proxy.setSaveResult(
      Object.assign(
        { success: false, error: "future device detail" },
        { errorCode: "future_code" },
      ),
    );
    expect(await save()).toEqual({ success: false, error: "future device detail" });
  });
  test.each(["save", "listSaved", "deleteSaved"] as const)(
    "%s thrown request is a failure",
    async (action) => {
      const methods = {
        save: "requestSavePrototype",
        listSaved: "requestListSavedPrototypes",
        deleteSaved: "requestDeleteSavedPrototype",
      };
      proxy.setFailureMode(methods[action], new Error("socket closed"));
      const output = await call({
        action,
        ...(action === "save" ? { spec } : action === "deleteSaved" ? { id: "demo" } : {}),
      });
      expect(output.success).toBe(false);
      expect(output.error).toContain("socket closed");
    },
  );
  test("list entries and empty list", async () => {
    const entry = { id: "demo", label: "Demo", slug: "demo", savedAt: 123, pinned: false };
    proxy.setListSavedResult({ success: true, savedPrototypes: [entry] });
    expect(await call({ action: "listSaved" })).toEqual({
      success: true,
      savedPrototypes: [entry],
    });
    proxy.setListSavedResult({ success: true });
    expect(await call({ action: "listSaved" })).toEqual({ success: true, savedPrototypes: [] });
  });
  test("delete succeeds without saved metadata and warns about disabled icons", async () => {
    proxy.setDeleteResult({ success: true, saved });
    expect(await call({ action: "deleteSaved", id: "demo" })).toEqual({
      success: true,
      warning: "A deleted prototype's disabled home-screen icon may remain.",
    });
    expect(proxy.deleteRequests).toEqual(["demo"]);
  });
  test("delete not_found is a failure", async () => {
    proxy.setDeleteResult({ success: false, errorCode: "not_found" });
    expect(await call({ action: "deleteSaved", id: "demo" })).toEqual({
      success: false,
      errorCode: "not_found",
      error: savedPrototypeErrorMessages.not_found,
    });
  });
  const CLEAR = "shell cmd shortcut clear-shortcuts dev.jasonpearson.automobile.ctrlproxy";
  test("deleteSaved without removeIcon never runs adb", async () => {
    const output = await call({ action: "deleteSaved", id: "demo" });
    expect(output.warning).toContain("disabled home-screen icon may remain");
    expect(adb.getExecutedCommands()).toEqual([]);
  });
  test("removeIcon clears shortcuts only when no saved prototype remains", async () => {
    proxy.setListSavedResult({ success: true, savedPrototypes: [] });
    const output = await call({ action: "deleteSaved", id: "demo", removeIcon: true });
    expect(output).toMatchObject({ success: true });
    expect(output.warning).toContain("Cleared");
    expect(proxy.deleteRequests).toEqual(["demo"]);
    expect(adb.getExecutedCommands()).toEqual([CLEAR]);
  });
  test("removeIcon leaves the icon while other prototypes remain", async () => {
    proxy.setListSavedResult({
      success: true,
      savedPrototypes: [{ id: "other", label: "Other", slug: "other", savedAt: 1, pinned: true }],
    });
    const output = await call({ action: "deleteSaved", id: "demo", removeIcon: true });
    expect(output.warning).toContain("Other saved prototypes remain");
    expect(adb.getExecutedCommands()).toEqual([]);
  });
  test("removeIcon reports an adb failure without failing the delete", async () => {
    proxy.setListSavedResult({ success: true, savedPrototypes: [] });
    adb.setCommandError(CLEAR, new Error("device offline"));
    const output = await call({ action: "deleteSaved", id: "demo", removeIcon: true });
    expect(output.success).toBe(true);
    expect(output.warning).toContain("Clearing the icon failed: device offline");
  });
  test.each(["save", "listSaved", "deleteSaved"] as const)(
    "%s capability absent makes no request",
    async (action) => {
      proxy.setSupportedCommands([]);
      expect(
        await call({
          action,
          ...(action === "save"
            ? { spec, assets }
            : action === "deleteSaved"
              ? { id: "demo" }
              : {}),
        }),
      ).toMatchObject({ success: false, errorCode: "unsupported_capability" });
      expect(reader.reads).toEqual([]);
      expect(proxy.getPrototypeAssetHistory()).toEqual([]);
      expect(proxy.saveRequests).toEqual([]);
      expect(proxy.deleteRequests).toEqual([]);
      expect(proxy.listCalls).toBe(0);
    },
  );
  test.each(SAVED_PROTOTYPE_ERROR_CODES)("store error %s is actionable", async (errorCode) => {
    proxy.setSaveResult({ success: false, errorCode, error: "device detail" });
    const message = savedPrototypeErrorMessages[errorCode];
    expect(message.length).toBeGreaterThan(0);
    expect(await save()).toEqual({ success: false, errorCode, error: `${message} device detail` });
    expect(new Set(Object.values(savedPrototypeErrorMessages)).size).toBe(
      SAVED_PROTOTYPE_ERROR_CODES.length,
    );
  });
  test("unrecognised failure preserves device text without a code", async () => {
    // A future wire code is intentionally not part of the typed protocol yet.
    proxy.setSaveResult(
      Object.assign(
        { success: false, error: "future device detail" },
        { errorCode: "future_code" },
      ),
    );
    expect(await save()).toEqual({ success: false, error: "future device detail" });
  });
  test.each(["save", "listSaved", "deleteSaved"] as const)(
    "%s thrown request is a failure",
    async (action) => {
      const methods = {
        save: "requestSavePrototype",
        listSaved: "requestListSavedPrototypes",
        deleteSaved: "requestDeleteSavedPrototype",
      };
      proxy.setFailureMode(methods[action], new Error("socket closed"));
      const output = await call({
        action,
        ...(action === "save" ? { spec } : action === "deleteSaved" ? { id: "demo" } : {}),
      });
      expect(output.success).toBe(false);
      expect(output.error).toContain("socket closed");
    },
  );
  test("list entries and empty list", async () => {
    const entry = { id: "demo", label: "Demo", slug: "demo", savedAt: 123, pinned: false };
    proxy.setListSavedResult({ success: true, savedPrototypes: [entry] });
    expect(await call({ action: "listSaved" })).toEqual({
      success: true,
      savedPrototypes: [entry],
    });
    proxy.setListSavedResult({ success: true });
    expect(await call({ action: "listSaved" })).toEqual({ success: true, savedPrototypes: [] });
  });
  test("delete succeeds without saved metadata and warns about disabled icons", async () => {
    proxy.setDeleteResult({ success: true, saved });
    expect(await call({ action: "deleteSaved", id: "demo" })).toEqual({
      success: true,
      warning: "A deleted prototype's disabled home-screen icon may remain.",
    });
    expect(proxy.deleteRequests).toEqual(["demo"]);
  });
  test("delete not_found is a failure", async () => {
    proxy.setDeleteResult({ success: false, errorCode: "not_found" });
    expect(await call({ action: "deleteSaved", id: "demo" })).toEqual({
      success: false,
      errorCode: "not_found",
      error: savedPrototypeErrorMessages.not_found,
    });
  });
  test.each(["save", "listSaved", "deleteSaved"] as const)(
    "physical iOS %s refuses before agent lookup",
    async (action) => {
      for (const isConnected of [true, false]) {
        connected = isConnected;
        expect(
          await call(
            {
              action,
              ...(action === "save" ? { spec } : action === "deleteSaved" ? { id: "demo" } : {}),
            },
            ios,
          ),
        ).toMatchObject({ success: false, errorCode: "unsupported_platform" });
      }
      expect(agent.requests).toEqual([]);
    },
  );
  test("read classification and neighbour show", async () => {
    for (const action of ["save", "listSaved", "deleteSaved"] as const) {
      expect(
        isPrototypeReadAction(
          prototypeSchema.parse({
            action,
            ...(action === "save" ? { spec } : action === "deleteSaved" ? { id: "demo" } : {}),
          }),
        ),
      ).toBe(action === "listSaved");
    }
    expect((await call({ action: "show", spec })).success).toBe(true);
  });
  test("schema parses new and existing inputs unchanged", () => {
    for (const input of [
      { action: "save", spec },
      { action: "listSaved" },
      { action: "deleteSaved", id: "demo" },
      { action: "show", spec },
      { action: "patch", id: "demo", ops: [{ op: "replace", path: "/data/x", value: 1 }] },
      { action: "dismiss", id: "demo" },
    ]) {
      expect(prototypeSchema.parse(input)).toEqual(input);
    }
  });
  test("allowed-field matrix and required fields", () => {
    const fields = {
      spec,
      specPath: "/spec.json",
      assets,
      label: "Demo",
      icon: "logo",
      pin: true,
      autoConfirm: true,
      id: "demo",
      ops: [{ op: "remove", path: "/data/x" }],
      removeIcon: true,
      all: true,
      display: "active",
      reset: true,
      appearance: "dark",
      eventName: "clicked",
      kind: "emit",
      afterSequence: 1,
      baseRevision: 1,
    };
    for (const [field, value] of Object.entries(fields)) {
      expect(prototypeSchema.safeParse({ action: "listSaved", [field]: value }).success).toBe(
        false,
      );
      if (!["id", "removeIcon"].includes(field)) {
        expect(
          prototypeSchema.safeParse({ action: "deleteSaved", id: "demo", [field]: value }).success,
        ).toBe(false);
      }
      if (!["spec", "assets", "label", "icon", "pin", "autoConfirm"].includes(field)) {
        expect(prototypeSchema.safeParse({ action: "save", spec, [field]: value }).success).toBe(
          false,
        );
      }
    }
    for (const input of [
      { action: "save" },
      { action: "deleteSaved" },
      { action: "save", spec, autoConfirm: true },
      { action: "save", spec, label: "x".repeat(121) },
      { action: "save", spec, label: "" },
      { action: "save", spec, icon: "logo" },
    ]) {
      expect(prototypeSchema.safeParse(input).success).toBe(false);
    }
  });
});
