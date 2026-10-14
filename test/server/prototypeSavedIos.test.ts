import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import { prototypeOutputSchema, registerPrototypeTools } from "../../src/server/prototypeTools";
import {
  savedPrototypeErrorMessages,
  type IosSavedPrototypeInstaller,
} from "../../src/server/prototypeSavedActions";
import {
  IosPrototypeInstaller,
  type InstalledPrototype,
  type PrototypeInstallInput,
} from "../../src/features/prototype/ios/iosPrototypeInstaller";
import { PrototypeInstallPhysicalDeviceError } from "../../src/features/prototype/ios/iosPrototypeInstallerErrors";
import { PrototypeViewerTemplateProvider } from "../../src/features/prototype/ios/iosPrototypeViewerTemplateProvider";
import {
  PROTOTYPE_BUNDLE_ID_PREFIX,
  prototypeBundleId,
} from "../../src/features/prototype/ios/iosPrototypeBundleId";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { ActionableError } from "../../src/models/ActionableError";
import type { BootedDevice } from "../../src/models";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { FakeHostCommandExecutor } from "../fakes/FakeHostCommandExecutor";
import {
  InstallerOperationRecorder,
  FakeTemplateProvider,
  FakeInstallerFileSystem,
  FakePrototypePlist,
  FakePrototypeIconRenderer,
  FakePrototypeSimctl,
  FakePrototypeDataWriter,
} from "../fakes/FakePrototypeInstaller";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const ios: BootedDevice = {
  deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
  platform: "ios",
  name: "Fake simulator",
};
const spec = {
  id: "My Demo",
  window: { placement: { type: "fullscreen" as const } },
  root: { type: "text" as const, text: "Hello" },
};
const bundleId = prototypeBundleId(spec.id);
const slug = bundleId.slice(PROTOTYPE_BUNDLE_ID_PREFIX.length);
const png = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 0]);
const assets = [{ id: "logo", path: "/img/logo.png" }];

class FakeSavedInstaller implements IosSavedPrototypeInstaller {
  readonly calls: string[] = [];
  readonly installs: PrototypeInstallInput[] = [];
  readonly deletes: Array<string | { prototypeId: string }> = [];
  apps: InstalledPrototype[] = [];
  error?: Error;
  afterList?: () => void;
  async install(input: PrototypeInstallInput): Promise<InstalledPrototype> {
    this.record("install", input.udid);
    this.installs.push(input);
    const app = { bundleId: prototypeBundleId(input.prototypeId), displayName: input.label };
    this.apps = [...this.apps.filter((entry) => entry.bundleId !== app.bundleId), app];
    return app;
  }
  async list(udid: string): Promise<InstalledPrototype[]> {
    this.record("list", udid);
    this.afterList?.();
    return this.apps;
  }
  async delete(udid: string, target: string | { prototypeId: string }): Promise<void> {
    this.record("delete", udid);
    this.deletes.push(target);
    const id = typeof target === "string" ? target : prototypeBundleId(target.prototypeId);
    this.apps = this.apps.filter((entry) => entry.bundleId !== id);
  }
  private record(action: string, udid: string) {
    expect(udid).toBe(ios.deviceId);
    this.calls.push(action);
    if (this.error) {
      throw this.error;
    }
  }
}

describe("iOS saved prototype tool actions", () => {
  let installer: FakeSavedInstaller;
  let reader: FakePrototypeAssetFileReader;
  let store: InMemoryPrototypeStatusStore;
  let restore: () => void;
  let dispose: () => void;
  let agentLookups: number;
  let androidLookups: number;
  let observationReads: string[];
  function setup(backend?: IosSavedPrototypeInstaller) {
    restore = preserveToolRegistry();
    installer = new FakeSavedInstaller();
    reader = new FakePrototypeAssetFileReader().addFile("/img/logo.png", png);
    const timer = new FakeTimer();
    store = new InMemoryPrototypeStatusStore(timer);
    agentLookups = 0;
    androidLookups = 0;
    observationReads = [];
    dispose = registerPrototypeTools({
      iosSavedPrototypeInstaller: backend ?? installer,
      assetFileReader: reader,
      observationScreenshotReader: async (uri) => {
        observationReads.push(uri);
        return { bytes: png };
      },
      clientFactory: () => {
        androidLookups++;
        throw new Error("Saved iOS actions must not resolve Android transport");
      },
      agentConnections: {
        get: () => {
          agentLookups++;
          throw new Error("Saved iOS actions must not resolve a prototype agent");
        },
      },
      store,
      timer,
      clock: timer,
      lifecycle: {
        subscribeSessionRelease: () => () => {},
        subscribeDeviceRemoval: () => () => {},
        subscribeDeviceUnbound: () => () => {},
      },
    });
  }
  async function call(input: unknown, device = ios, signal?: AbortSignal) {
    const result = await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(
      device,
      input,
      undefined,
      signal,
    );
    return prototypeOutputSchema.parse(result.structuredContent);
  }
  const save = (extra: Record<string, unknown> = {}, signal?: AbortSignal) =>
    call({ action: "save", spec, ...extra }, ios, signal);
  beforeAll(async () => {
    setup();
    try {
      await save({ assets, icon: "logo", pin: true });
      await call({ action: "listSaved" });
      await call({ action: "deleteSaved", id: spec.id, removeIcon: true });
    } finally {
      dispose();
      restore();
    }
  });
  beforeEach(() => setup());
  afterEach(() => {
    expect(agentLookups).toBe(0);
    expect(androidLookups).toBe(0);
    expect(store.status({ deviceId: ios.deviceId })).toEqual({ prototypes: [] });
    dispose();
    restore();
  });

  test("save, replace, list and delete round trip without an agent or live state", async () => {
    expect(await save()).toEqual({ success: true, saved: { id: spec.id, slug, replaced: false } });
    expect(installer.installs[0]).toMatchObject({
      udid: ios.deviceId,
      prototypeId: spec.id,
      label: spec.id,
      spec,
      assets: [],
    });
    expect(installer.installs[0].icon).toBeUndefined();
    expect(await save({ label: "Updated" })).toEqual({
      success: true,
      saved: { id: spec.id, slug, replaced: true },
    });
    expect(await call({ action: "listSaved" })).toEqual({
      success: true,
      savedPrototypes: [{ id: bundleId, label: "Updated", slug, pinned: false }],
    });
    expect(await call({ action: "deleteSaved", id: bundleId })).toEqual({ success: true });
    expect(installer.deletes).toEqual([bundleId]);
    expect(await call({ action: "listSaved" })).toEqual({ success: true, savedPrototypes: [] });
    expect(installer.calls).toEqual([
      "list",
      "install",
      "list",
      "install",
      "list",
      "list",
      "delete",
      "list",
    ]);
  });
  test("assets reach the installer and the uploaded icon becomes image bytes", async () => {
    expect(await save({ assets, icon: "logo", label: "Demo" })).toMatchObject({
      success: true,
      uploadedAssets: [{ id: "logo", mimeType: "image/png", bytes: png.length }],
    });
    expect(installer.installs[0]).toEqual({
      udid: ios.deviceId,
      prototypeId: spec.id,
      label: "Demo",
      spec,
      assets: [{ id: "logo", mimeType: "image/png", bytes: png }],
      icon: { image: png },
    });
    expect(reader.reads).toEqual(["/img/logo.png"]);
  });
  test("observation assets use the shared reader without a device upload", async () => {
    const observation = "automobile:observation/test/screenshot";
    expect((await save({ assets: [{ id: "logo", observation }] })).success).toBe(true);
    expect(observationReads).toEqual([observation]);
    expect(installer.installs[0].assets).toEqual([
      { id: "logo", mimeType: "image/png", bytes: png },
    ]);
  });
  test("save expands components before handing the spec to the installer", async () => {
    const authored = {
      ...spec,
      components: { greeting: { root: { type: "text", text: "Hello {props.name}" } } },
      root: { type: "use", component: "greeting", props: { name: "Ada" } },
    };
    expect((await save({ spec: authored })).success).toBe(true);
    expect(installer.installs[0].spec).toEqual({
      ...spec,
      root: { type: "text", text: "Hello Ada" },
    });
  });
  test("invalid spec reports the validator path before any installer or file call", async () => {
    const output = await save({ spec: { ...spec, root: { type: "unknown" } }, assets });
    expect(output.success).toBe(false);
    expect(output.error).toContain("root.type");
    expect(installer.calls).toEqual([]);
    expect(reader.reads).toEqual([]);
  });
  test("device persistence is refused before any installer or asset work", async () => {
    expect(
      await save({ spec: { ...spec, window: { ...spec.window, persistence: "device" } }, assets }),
    ).toEqual({
      success: false,
      error: 'window.persistence "device" is Android only; omit it on iOS.',
    });
    expect(installer.calls).toEqual([]);
    expect(reader.reads).toEqual([]);
    expect(observationReads).toEqual([]);
  });
  test("element anchors are refused before any installer or asset work", async () => {
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
    const output = await save({ spec: anchored, assets });
    expect(output).toMatchObject({ success: false, errorCode: "invalid_spec" });
    expect(output.error?.toLowerCase()).toContain("element anchors");
    expect(installer.calls).toEqual([]);
    expect(reader.reads).toEqual([]);
  });
  test("app layer remains accepted for iOS save", async () => {
    const layered = { ...spec, window: { ...spec.window, layer: "app" } };
    expect(await save({ spec: layered })).toEqual({
      success: true,
      saved: { id: spec.id, slug, replaced: false },
    });
    expect(installer.installs[0].spec).toEqual(layered);
  });
  test("unset viewer template surfaces build and environment instructions in the handler error", async () => {
    dispose();
    restore();
    const operations = new InstallerOperationRecorder();
    const commands = new FakeHostCommandExecutor();
    setup(
      new IosPrototypeInstaller({
        template: new PrototypeViewerTemplateProvider({
          env: { AUTOMOBILE_IOS_PROTOTYPE_VIEWER: "/nonexistent/PrototypeViewer.app" },
        }),
        files: new FakeInstallerFileSystem(operations),
        plist: new FakePrototypePlist(operations),
        icons: new FakePrototypeIconRenderer(operations),
        commands,
        simctl: new FakePrototypeSimctl(operations),
        data: new FakePrototypeDataWriter(operations),
      }),
    );
    expect(await save()).toEqual({
      success: false,
      error:
        "Could not resolve the prototype viewer template: The prototype viewer configured by AUTOMOBILE_IOS_PROTOTYPE_VIEWER must be an existing app directory containing Info.plist: /nonexistent/PrototypeViewer.app. Build one with scripts/ios/prototype-viewer-build.sh and set AUTOMOBILE_IOS_PROTOTYPE_VIEWER to the resulting PrototypeViewer.app.",
    });
    expect(operations.events).toEqual(["list"]);
    expect(commands.getExecutedCommands()).toEqual([]);
  });
  test("icon must be uploaded in the same save call", async () => {
    const output = await save({ icon: "logo" });
    expect(output.success).toBe(false);
    expect(output.error).toContain("icon must be an asset uploaded in assets in this call");
    expect(installer.calls).toEqual([]);
  });
  test.each(["missing", "invalid", "duplicate"])(
    "asset prepare failure %s makes zero installer calls",
    async (failure) => {
      reader.addFile("/img/invalid.png", Buffer.from("invalid image"));
      const sources =
        failure === "duplicate"
          ? [...assets, ...assets]
          : [{ id: "logo", path: `/img/${failure}.png` }];
      const output = await save({ assets: sources });
      expect(output.success).toBe(false);
      expect(output.error).toContain("The prototype was not saved.");
      expect(installer.calls).toEqual([]);
    },
  );
  test("pin and autoConfirm retain the shared unsupported result", async () => {
    expect(await save({ pin: true, autoConfirm: true })).toMatchObject({
      success: true,
      pinned: "unsupported",
      warning: "Pinning is not available on iOS simulators; the app icon is on the home screen.",
    });
  });
  test("list falls back to slug without inventing a save time", async () => {
    installer.apps = [{ bundleId }];
    expect(await call({ action: "listSaved" })).toEqual({
      success: true,
      savedPrototypes: [{ id: bundleId, slug, label: slug, pinned: false }],
    });
  });
  test("delete by authored id ignores removeIcon with the iOS warning", async () => {
    installer.apps = [{ bundleId }];
    expect(await call({ action: "deleteSaved", id: spec.id, removeIcon: true })).toEqual({
      success: true,
      warning:
        "Icon removal does not apply on iOS simulators; deleting the prototype removes its app icon.",
    });
    expect(installer.deletes).toEqual([{ prototypeId: spec.id }]);
    expect(installer.calls).toEqual(["list", "delete"]);
  });
  test.each(["unknown prototype", prototypeBundleId("unknown prototype"), "com.apple.Maps"])(
    "delete of absent prototype %s returns not_found without uninstalling",
    async (id) => {
      installer.apps = [{ bundleId }, { bundleId: "com.apple.Maps" }];
      expect(await call({ action: "deleteSaved", id, removeIcon: true })).toEqual({
        success: false,
        errorCode: "not_found",
        error: savedPrototypeErrorMessages.not_found,
      });
      expect(installer.calls).toEqual(["list"]);
      expect(installer.deletes).toEqual([]);
    },
  );
  test("deleting the same prototype twice returns not_found on the second request", async () => {
    await save();
    expect(await call({ action: "deleteSaved", id: spec.id })).toEqual({ success: true });
    expect(await call({ action: "deleteSaved", id: spec.id })).toEqual({
      success: false,
      errorCode: "not_found",
      error: savedPrototypeErrorMessages.not_found,
    });
    expect(installer.deletes).toEqual([{ prototypeId: spec.id }]);
  });
  test("cancellation during the delete lookup does not uninstall", async () => {
    installer.apps = [{ bundleId }];
    const controller = new AbortController();
    installer.afterList = () => controller.abort();
    expect(
      (await call({ action: "deleteSaved", id: bundleId }, ios, controller.signal)).success,
    ).toBe(false);
    expect(installer.calls).toEqual(["list"]);
    expect(installer.deletes).toEqual([]);
  });
  test.each(["save", "listSaved", "deleteSaved"] as const)(
    "physical device %s refuses without filesystem events",
    async (action) => {
      dispose();
      restore();
      const operations = new InstallerOperationRecorder();
      const realInstaller = new IosPrototypeInstaller({
        template: new FakeTemplateProvider(operations),
        files: new FakeInstallerFileSystem(operations),
        plist: new FakePrototypePlist(operations),
        icons: new FakePrototypeIconRenderer(operations),
        commands: new FakeHostCommandExecutor(),
        simctl: new FakePrototypeSimctl(operations),
        data: new FakePrototypeDataWriter(operations),
      });
      setup(realInstaller);
      const output = await call(
        {
          action,
          ...(action === "save"
            ? { spec, assets }
            : action === "deleteSaved"
              ? { id: spec.id }
              : {}),
        },
        { ...ios, deviceId: "00008110-0012345678901234" },
      );
      expect(output).toMatchObject({ success: false, errorCode: "unsupported_platform" });
      expect(output.error).toContain("iOS simulator");
      expect(output.error).toContain("deviceId or sessionUuid");
      expect(operations.events).toEqual([]);
      expect(reader.reads).toEqual([]);
    },
  );
  test.each(["save", "listSaved", "deleteSaved"] as const)(
    "installer physical error maps to platform refusal for %s",
    async (action) => {
      installer.error = new PrototypeInstallPhysicalDeviceError();
      expect(
        await call({
          action,
          ...(action === "save" ? { spec } : action === "deleteSaved" ? { id: spec.id } : {}),
        }),
      ).toMatchObject({ success: false, errorCode: "unsupported_platform" });
      expect(installer.installs).toEqual([]);
    },
  );
  test.each(["save", "listSaved", "deleteSaved"] as const)(
    "installer ActionableError message surfaces for %s",
    async (action) => {
      installer.error = new ActionableError("Check simulator storage and retry.");
      expect(
        await call({
          action,
          ...(action === "save" ? { spec } : action === "deleteSaved" ? { id: spec.id } : {}),
        }),
      ).toEqual({ success: false, error: installer.error.message });
    },
  );
  test.each(["initial", "prepare", "list"])("cancel at %s does not install", async (when) => {
    const controller = new AbortController();
    if (when === "initial") {
      controller.abort();
    } else if (when === "prepare") {
      const read = reader.readFile.bind(reader);
      reader.readFile = async (path) => {
        const bytes = await read(path);
        controller.abort();
        return bytes;
      };
    } else {
      installer.afterList = () => controller.abort();
    }
    const output = await save({ assets }, controller.signal);
    expect(output.success).toBe(false);
    expect(output.error).toContain("the request was cancelled");
    expect(installer.installs).toEqual([]);
    if (when !== "list") {
      expect(installer.calls).toEqual([]);
    }
  });
});
