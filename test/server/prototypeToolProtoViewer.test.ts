import {
  ProtoViewerEntryPointMissingError,
  ProtoViewerStorageError,
} from "../../src/features/prototype/protoViewer/protoViewerDevice";
import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { PROTOTYPE_SAVED_CAPABILITY } from "../../src/features/observe/android/ctrlProxyProtocol";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import type { ProtoViewerDevice } from "../../src/features/prototype/protoViewer/protoViewerDevice";
import type { ProtoViewerResult } from "../../src/features/prototype/protoViewer/protoViewerContract";
import { PROTOVIEWER_IMPORTED_WARNING } from "../../src/features/prototype/protoViewer/protoViewerSaved";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import type { BootedDevice } from "../../src/models";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeHierarchyCapture } from "../fakes/FakeHierarchyCapture";
import { FakeTimer } from "../fakes/FakeTimer";
import { pinDialogTree } from "../helpers/pinDialogTree";
import { toolStructured } from "../helpers/toolResponse";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const android: BootedDevice = { deviceId: "viewer-android", platform: "android", name: "Fake" };
const ios: BootedDevice = {
  deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  platform: "ios",
  name: "Fake",
};
const LIBRARY_ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const spec = {
  id: "demo",
  window: { placement: { type: "fullscreen" as const }, opacity: 100 },
  root: { type: "text" as const, text: "Hello" },
};
const viewer = { app: "protoviewer", libraryId: LIBRARY_ID, label: "Demo" } as const;

class FakeViewer implements ProtoViewerDevice {
  present = true;
  readonly calls: string[] = [];
  failure?: Error;
  async installed(): Promise<boolean> {
    this.calls.push("installed");
    return this.present;
  }
  async importBundle(_bytes: Uint8Array, label?: string): Promise<ProtoViewerResult> {
    this.calls.push(`import:${label ?? ""}`);
    if (this.failure) {
      throw this.failure;
    }
    return { status: "imported", request: "r", libraryId: LIBRARY_ID, label: label ?? "Demo" };
  }
  async open(libraryId: string): Promise<ProtoViewerResult> {
    this.calls.push(`open:${libraryId}`);
    return { status: "opened", request: "r", libraryId, label: "Demo" };
  }
}

describe("prototype save and open through ProtoViewer", () => {
  let proxy: FakeCtrlProxy;
  let fake: FakeViewer;
  let restore: () => void;
  let dispose: () => void;
  let installs: string[];
  function setup() {
    restore = preserveToolRegistry();
    const timer = new FakeTimer();
    proxy = new FakeCtrlProxy(timer);
    proxy.setSupportedCommands([PROTOTYPE_SAVED_CAPABILITY]);
    proxy.setSaveResult({ success: true, saved: { id: "demo", slug: "demo", replaced: false } });
    fake = new FakeViewer();
    installs = [];
    const assetReader = new FakePrototypeAssetFileReader();
    assetReader.addFile(
      "/logo.png",
      Buffer.from(
        "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==",
        "base64",
      ),
    );
    dispose = registerPrototypeTools({
      clientFactory: () => proxy,
      adbFactory: new FakeAdbClientFactory(new FakeAdbExecutor()),
      // A pinned save looks for the shortcut on the home screen (#14887): never the real device.
      anchorHierarchyCaptureFactory: () =>
        new FakeHierarchyCapture(() => pinDialogTree(["demo"]), "android", timer),
      protoViewerFactory: () => fake,
      iosSavedPrototypeInstaller: {
        install: async (input) => {
          installs.push(input.prototypeId);
          return { bundleId: "dev.jasonpearson.automobile.prototype.demo" };
        },
        list: async () => [],
        delete: async () => {},
      },
      store: new InMemoryPrototypeStatusStore(timer),
      timer,
      clock: timer,
      assetFileReader: assetReader,
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
      lifecycle: {
        subscribeSessionRelease: () => () => {},
        subscribeDeviceRemoval: () => () => {},
        subscribeDeviceUnbound: () => () => {},
      },
    });
  }
  beforeAll(async () => {
    // Warm the module graph so every test stays inside the unit-test time budget.
    setup();
    try {
      await call({ action: "save", spec });
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
  async function call(input: Record<string, unknown>, device = android) {
    const result = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input);
    return prototypeOutputSchema.parse(toolStructured(result));
  }

  test("an Android save goes to ProtoViewer when it is installed, not to CtrlProxy", async () => {
    expect(await call({ action: "save", spec, label: "Demo" })).toEqual({
      success: true,
      viewer,
      warning: PROTOVIEWER_IMPORTED_WARNING,
    });
    expect(fake.calls).toEqual(["installed", "import:Demo"]);
    expect(proxy.saveRequests).toEqual([]);
  });

  test("without ProtoViewer the save keeps the CtrlProxy path", async () => {
    fake.present = false;
    expect(await call({ action: "save", spec })).toEqual({
      success: true,
      saved: { id: "demo", slug: "demo", replaced: false },
    });
    expect(proxy.saveRequests).toEqual([{ spec, label: "demo" }]);
  });

  test("a pinned save stays on CtrlProxy and never probes ProtoViewer", async () => {
    proxy.setPinResult({ success: true, pin: { id: "demo", status: "already_pinned" } });
    const output = await call({ action: "save", spec, pin: true });
    expect(output).toMatchObject({ success: true, pinned: "pinned" });
    expect(fake.calls).toEqual([]);
  });

  test("open launches a ProtoViewer library entry on Android", async () => {
    expect(await call({ action: "open", id: LIBRARY_ID })).toEqual({
      success: true,
      viewer,
      warning: PROTOVIEWER_IMPORTED_WARNING,
    });
    expect(fake.calls).toEqual(["installed", `open:${LIBRARY_ID}`]);
  });

  test("iOS save and open use ProtoViewer and return its imported warning", async () => {
    for (const args of [
      { action: "save", spec, label: "Demo" },
      { action: "open", id: LIBRARY_ID },
    ]) {
      expect(await call(args, ios)).toEqual({
        success: true,
        viewer,
        warning: PROTOVIEWER_IMPORTED_WARNING,
      });
    }
    expect(installs).toEqual([]);
  });

  test("iOS save falls back when absent, old, or storage unusable", async () => {
    for (const failure of [
      undefined,
      new ProtoViewerEntryPointMissingError(),
      new ProtoViewerStorageError("inbox"),
    ]) {
      fake.present = failure !== undefined;
      fake.failure = failure;
      expect(await call({ action: "save", spec }, ios)).toMatchObject({
        success: true,
        saved: { id: "demo" },
      });
    }
    expect(installs).toEqual(["demo", "demo", "demo"]);
  });

  test("iOS delivery ambiguity fails without installing a second copy", async () => {
    fake.failure = new Error("ProtoViewer did not answer; it may still have saved the prototype");
    expect(await call({ action: "save", spec }, ios)).toMatchObject({ success: false });
    expect(installs).toEqual([]);
  });

  test("iOS pinned and icon saves keep the template path", async () => {
    expect(await call({ action: "save", spec, pin: true }, ios)).toMatchObject({ success: true });
    // icon must name an uploaded asset; schema validation remains in force.
    expect(
      await call(
        {
          action: "save",
          spec,
          icon: "logo",
          assets: [{ id: "logo", path: "/logo.png" }],
        },
        ios,
      ),
    ).toMatchObject({ success: true });
    expect(fake.calls).toEqual([]);
    expect(installs).toEqual(["demo", "demo"]);
  });

  test("iOS open without ProtoViewer needs the capability; physical open needs a simulator", async () => {
    fake.present = false;
    expect(await call({ action: "open", id: LIBRARY_ID }, ios)).toMatchObject({
      success: false,
      errorCode: "unsupported_capability",
    });
    fake.calls.length = 0;
    expect(
      await call(
        { action: "open", id: LIBRARY_ID },
        { ...ios, deviceId: "00008110-001234567890001E" },
      ),
    ).toMatchObject({ success: false, errorCode: "unsupported_platform" });
    expect(fake.calls).toEqual([]);
  });

  test("open requires an id and takes no other mutation fields", async () => {
    expect((await call({ action: "open" })).error).toContain("open requires id");
    expect((await call({ action: "open", id: LIBRARY_ID, label: "x" })).error).toContain(
      "open allows id",
    );
    expect(fake.calls).toEqual([]);
  });

  test("save and open refuse a timeoutMs above the 60 s maximum", async () => {
    expect((await call({ action: "open", id: LIBRARY_ID, timeoutMs: 60_001 })).error).toContain(
      "open timeoutMs must not exceed 60000",
    );
    expect((await call({ action: "save", spec, timeoutMs: 60_001 })).error).toContain(
      "save timeoutMs must not exceed 60000",
    );
    expect(fake.calls).toEqual([]);
  });
});
