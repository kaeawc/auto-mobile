import { afterEach, beforeAll, beforeEach, describe, expect, test } from "bun:test";
import fs from "node:fs";
import path from "node:path";
import { DisposableAppManager } from "../../src/features/prototype/disposableApp/DisposableAppManager";
import { FileDisposableAppRegistry } from "../../src/features/prototype/disposableApp/DisposableAppRegistry";
import { disposableAppId } from "../../src/features/prototype/disposableApp/disposableAppId";
import { InMemoryPrototypeStatusStore } from "../../src/features/prototype/PrototypeStatusStore";
import type { BootedDevice } from "../../src/models";
import {
  isPrototypeReadAction,
  prototypeOutputSchema,
  prototypeSchema,
  registerPrototypeTools,
} from "../../src/server/prototypeTools";
import { ToolRegistry } from "../../src/server/toolRegistry";
import { FakePrototypeAgentClient } from "../fakes/FakePrototypeAgentClient";
import { FakeCtrlProxy } from "../fakes/FakeCtrlProxy";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeDisposableAppInstaller } from "../fakes/FakeDisposableAppInstaller";
import { FakeDisposableAppStamper } from "../fakes/FakeDisposableAppStamper";
import { FakePrototypeAssetFileReader } from "../fakes/FakePrototypeAssetFileReader";
import { FakeTimer } from "../fakes/FakeTimer";
import { InMemoryDisposableAppRegistryStore } from "../fakes/InMemoryDisposableAppRegistryStore";
import { toolStructured } from "../helpers/toolResponse";
import { preserveToolRegistry } from "../helpers/withTemporaryTool";

const HOUR = 60 * 60 * 1000;
const android: BootedDevice = { deviceId: "apps-android", platform: "android", name: "Fake" };
const iphone: BootedDevice = {
  deviceId: "00008030-001C195E0A91802E",
  platform: "ios",
  name: "Fake iPhone",
};
const specText = fs.readFileSync(
  path.join(import.meta.dir, "../fixtures/prototype-spec/valid/platform-requires.json"),
  "utf8",
);
const spec = JSON.parse(specText);
const app = { slug: "feedly", label: "Feedly" };
const appId = disposableAppId("android", "feedly");

describe("prototype disposable app actions (#14184)", () => {
  // The lazily imported runtime is a one-time process cost, not part of any test's budget.
  beforeAll(async () => {
    await import("../../src/server/prototypeTools/runtime");
    // So is compiling the tool's input and output schemas on their first parse.
    prototypeSchema.parse({ action: "installApp", spec, app });
    prototypeOutputSchema.parse({ success: true });
  });
  let restore: () => void;
  let dispose: () => void;
  let timer: FakeTimer;
  let forgotten: [string, string][];
  let installer: FakeDisposableAppInstaller;
  let stamper: FakeDisposableAppStamper;
  beforeEach(() => {
    restore = preserveToolRegistry();
    forgotten = [];
    timer = new FakeTimer();
    installer = new FakeDisposableAppInstaller();
    stamper = new FakeDisposableAppStamper([
      {
        name: "media",
        capabilities: ["prototype_platform_v1", "prototype_platform_test_v1"],
        size: 2,
      },
    ]);
    const proxy = new FakeCtrlProxy(timer);
    dispose = registerPrototypeTools({
      clientFactory: () => proxy,
      disposableAppAttacher: {
        attach: async () => new FakePrototypeAgentClient(),
        release: async () => {},
        dispose: async () => {},
        forget: async (deviceId, id) => {
          forgotten.push([deviceId, id]);
        },
      },
      store: new InMemoryPrototypeStatusStore(timer),
      timer,
      clock: timer,
      assetFileReader: new FakePrototypeAssetFileReader().addFile(
        "/specs/app.json",
        Buffer.from(specText),
      ),
      cacheInvalidator: new FakeDeviceWindowCacheInvalidator(),
      lifecycle: {
        subscribeSessionRelease: () => () => {},
        subscribeDeviceRemoval: () => () => {},
        subscribeDeviceUnbound: () => () => {},
      },
      disposableApps: new DisposableAppManager({
        platforms: { android: { stamper, installer } },
        registry: new FileDisposableAppRegistry(new InMemoryDisposableAppRegistryStore()),
        timer,
      }),
    });
  });
  afterEach(() => {
    dispose();
    restore();
  });
  const call = async (input: Record<string, unknown>, device: BootedDevice = android) =>
    prototypeOutputSchema.parse(
      toolStructured(await ToolRegistry.getTool("prototype")!.deviceAwareHandler!(device, input)),
    );

  test("installApp stamps the spec as its own app with the spec's declared permissions", async () => {
    const output = await call({
      action: "installApp",
      spec,
      app: { ...app, icon: { backgroundColor: "#2E59BF" }, permissions: "grantDeclared" },
    });
    expect(output.success).toBe(true);
    expect(output.disposableApp).toMatchObject({
      appId,
      platform: "android",
      label: "Feedly",
      template: "media",
      expiresAt: new Date(72 * HOUR).toISOString(),
      permissions: { declared: ["camera", "notifications"], granted: ["camera", "notifications"] },
      updated: false,
      launched: false,
    });
    expect(stamper.stamped[0]?.icon).toEqual({ backgroundColor: "#2E59BF" });
    expect(installer.installs).toHaveLength(1);
  });

  test("installApp reads specPath, and a re-install of the slug is an in-place update", async () => {
    await call({ action: "installApp", specPath: "/specs/app.json", app });
    const again = await call({ action: "installApp", specPath: "/specs/app.json", app });
    expect(again.disposableApp?.updated).toBe(true);
    expect(installer.installs).toHaveLength(2);
  });

  test("successful reinstall and uninstall forget the app attachment", async () => {
    await call({ action: "installApp", spec, app });
    forgotten.length = 0;
    await call({ action: "installApp", spec, app });
    expect(forgotten).toEqual([[android.deviceId, appId]]);
    forgotten.length = 0;
    await call({ action: "uninstallApp", appId });
    expect(forgotten).toEqual([[android.deviceId, appId]]);
  });

  test("bulk expiry forgets removed apps while retaining skipped apps", async () => {
    await call({ action: "installApp", spec, app: { ...app, ttlHours: 1 } });
    await call({ action: "installApp", spec, app: { slug: "keep", label: "Keep", ttlHours: 0 } });
    forgotten.length = 0;
    timer.advanceTime(2 * HOUR);
    await call({ action: "uninstallApp", expired: true });
    expect(forgotten).toEqual([[android.deviceId, appId]]);
  });

  test("listApps joins the registry with unregistered device packages under the prefix", async () => {
    await call({ action: "installApp", spec, app: { ...app, ttlHours: 1 } });
    const stray = disposableAppId("android", "stray");
    installer.seed(android.deviceId, stray, "host-key");
    timer.advanceTime(HOUR);
    const output = await call({ action: "listApps" });
    expect(output.disposableApps).toEqual([
      expect.objectContaining({ appId, registered: true, installed: true, expired: true }),
      { appId: stray, registered: false, installed: true, expired: false },
    ]);
  });

  test("uninstallApp expired removes only expired apps and reports each removal", async () => {
    await call({ action: "installApp", spec, app: { ...app, ttlHours: 1 } });
    await call({ action: "installApp", spec, app: { slug: "keep", label: "Keep", ttlHours: 0 } });
    timer.advanceTime(2 * HOUR);
    const output = await call({ action: "uninstallApp", expired: true });
    expect(output.uninstalled).toEqual({
      removed: [{ appId, reason: "expired" }],
      skipped: [],
    });
    expect(installer.uninstalls).toEqual([appId]);
  });

  test("uninstallApp refuses an app signed by another key and an id outside the prefix", async () => {
    installer.seed(android.deviceId, appId, "foreign-key");
    const foreign = await call({ action: "uninstallApp", appId });
    expect(foreign.success).toBe(false);
    expect(foreign.error).toContain("not signed by this host's disposable-app key");
    const outside = await call({ action: "uninstallApp", appId: "com.example.real" });
    expect(outside.success).toBe(false);
    expect(outside.error).toContain("is not a disposable prototype app");
    expect(installer.uninstalls).toEqual([]);
    expect(forgotten).toEqual([]);
  });

  test("installApp directs physical iPhones to ProtoViewer before stamping", async () => {
    const output = await call({ action: "installApp", spec, app }, iphone);
    expect(output.success).toBe(false);
    expect(output.error).toContain("Use ProtoViewer on a physical iPhone");
  });

  test("schema requires app and a spec source, and exactly one uninstall target", () => {
    const parses = (input: Record<string, unknown>) => prototypeSchema.safeParse(input).success;
    expect(parses({ action: "installApp", spec })).toBe(false);
    expect(parses({ action: "installApp", app })).toBe(false);
    expect(parses({ action: "installApp", spec, app: { ...app, slug: "Bad_Slug" } })).toBe(false);
    expect(parses({ action: "installApp", spec, app: { ...app, appId: "x" } })).toBe(false);
    expect(parses({ action: "installApp", spec, app })).toBe(true);
    expect(parses({ action: "uninstallApp" })).toBe(false);
    expect(parses({ action: "uninstallApp", all: true, expired: true })).toBe(false);
    expect(parses({ action: "uninstallApp", appId })).toBe(true);
    expect(parses({ action: "listApps", appId })).toBe(false);
    expect(parses({ action: "show", spec, app })).toBe(false);
  });

  test("listApps is a read; installApp and uninstallApp are control", () => {
    const read = (action: string) =>
      isPrototypeReadAction(prototypeSchema.parse({ action, appId }));
    expect(isPrototypeReadAction(prototypeSchema.parse({ action: "listApps" }))).toBe(true);
    expect(read("uninstallApp")).toBe(false);
    expect(isPrototypeReadAction(prototypeSchema.parse({ action: "installApp", spec, app }))).toBe(
      false,
    );
  });
});
