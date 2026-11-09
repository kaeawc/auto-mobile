import { beforeEach, describe, expect, test } from "bun:test";
import {
  DisposableAppManager,
  type DisposableAppInstallInput,
} from "../../../../src/features/prototype/disposableApp/DisposableAppManager";
import { disposableAppId } from "../../../../src/features/prototype/disposableApp/disposableAppId";
import { FileDisposableAppRegistry } from "../../../../src/features/prototype/disposableApp/DisposableAppRegistry";
import { FakeDisposableAppInstaller } from "../../../fakes/FakeDisposableAppInstaller";
import { FakeDisposableAppStamper } from "../../../fakes/FakeDisposableAppStamper";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { InMemoryDisposableAppRegistryStore } from "../../../fakes/InMemoryDisposableAppRegistryStore";
import fixture from "../../../fixtures/prototype-spec/valid/platform-requires.json";

const HOUR = 60 * 60 * 1000;
const DEVICE = "emulator-5554";
const media = {
  name: "media",
  capabilities: ["prototype_platform_v1", "prototype_platform_test_v1"],
  size: 2,
};

let timer: FakeTimer;
let stamper: FakeDisposableAppStamper;
let installer: FakeDisposableAppInstaller;
let registry: FileDisposableAppRegistry;
let manager: DisposableAppManager;

function input(app: Partial<DisposableAppInstallInput["app"]> = {}): DisposableAppInstallInput {
  return {
    deviceId: DEVICE,
    platform: "android",
    spec: fixture,
    app: { slug: "feedly", label: "Feedly", ...app },
  };
}

beforeEach(() => {
  timer = new FakeTimer();
  stamper = new FakeDisposableAppStamper([{ name: "base", capabilities: [], size: 1 }, media]);
  installer = new FakeDisposableAppInstaller();
  registry = new FileDisposableAppRegistry(new InMemoryDisposableAppRegistryStore());
  manager = new DisposableAppManager({
    platforms: { android: { stamper, installer } },
    registry,
    timer,
  });
});

describe("DisposableAppManager.install", () => {
  test("stamps the smallest covering template with the spec's declared permissions", async () => {
    const result = await manager.install(input({ permissions: "grantDeclared" }));
    const appId = disposableAppId("android", "feedly");
    expect(result).toEqual({
      appId,
      platform: "android",
      label: "Feedly",
      version: "1.0.1",
      expiresAt: new Date(72 * HOUR).toISOString(),
      template: "media",
      permissions: {
        declared: ["camera", "notifications"],
        granted: ["camera", "notifications"],
        denied: [],
      },
      updated: false,
      launched: false,
    });
    expect(stamper.stamped[0]?.declarations.android.permissions).toContain(
      "android.permission.CAMERA",
    );
    expect(installer.grants).toEqual([
      { appId, grants: { granted: ["camera", "notifications"], denied: [] } },
    ]);
    expect((await registry.list(DEVICE))[0]).toMatchObject({ appId, template: "media" });
  });

  test("re-installing a slug updates in place and keeps storage unless reset", async () => {
    await manager.install(input());
    const again = await manager.install(input({ label: "Feedly 2", reset: true }));
    expect(again.updated).toBe(true);
    expect(installer.installs.map((entry) => entry.reset)).toEqual([false, true]);
    expect((await registry.list(DEVICE)).map((entry) => entry.label)).toEqual(["Feedly 2"]);
  });

  test("a first install whose permissions fail is still recorded with its TTL", async () => {
    installer.permissionFailure = new Error("pm grant failed");
    const appId = disposableAppId("android", "feedly");
    await expect(manager.install(input({ ttlHours: 1 }))).rejects.toThrow(
      `${appId} is installed on ${DEVICE} (expires ${new Date(HOUR).toISOString()}), but its permissions were not applied: pm grant failed.`,
    );
    expect(await registry.list(DEVICE)).toEqual([
      expect.objectContaining({ appId, installedAt: 0, expiresAt: HOUR }),
    ]);
    timer.advanceTime(HOUR);
    const swept = await manager.sweepExpired(DEVICE, "android");
    expect(swept.removed).toEqual([{ appId, reason: "expired" }]);
  });

  test("a reinstall whose permissions fail replaces the stale expiry and survives the sweep", async () => {
    await manager.install(input({ ttlHours: 1 }));
    timer.advanceTime(HOUR);
    installer.permissionFailure = new Error("pm grant failed");
    await expect(manager.install(input({ ttlHours: 0 }))).rejects.toThrow(
      /installed on emulator-5554 \(expires never\), but its permissions were not applied/,
    );
    const appId = disposableAppId("android", "feedly");
    expect(await registry.list(DEVICE)).toEqual([
      expect.objectContaining({ appId, installedAt: HOUR, expiresAt: null }),
    ]);
    expect(await manager.sweepExpired(DEVICE, "android")).toEqual({ removed: [], skipped: [] });
    expect(installer.uninstalls).toEqual([]);
  });

  test("refuses an unsupported platform and an out-of-range TTL before stamping", async () => {
    await expect(manager.install({ ...input(), platform: "ios" })).rejects.toThrow(
      /not available on ios/,
    );
    await expect(manager.install(input({ ttlHours: -1 }))).rejects.toThrow(/ttlHours/);
    await expect(manager.install(input({ ttlHours: 1.5 }))).rejects.toThrow(/ttlHours/);
    expect(stamper.stamped).toEqual([]);
  });
});

describe("DisposableAppManager TTL and uninstall", () => {
  test("the expiry sweep removes only apps whose TTL has passed", async () => {
    await manager.install(input({ ttlHours: 1 }));
    await manager.install(input({ slug: "keeper", ttlHours: 0 }));
    await manager.install(input({ slug: "later" }));
    timer.advanceTime(HOUR - 1);
    expect((await manager.sweepExpired(DEVICE, "android")).removed).toEqual([]);
    timer.advanceTime(1);
    const swept = await manager.sweepExpired(DEVICE, "android");
    expect(swept).toEqual({
      removed: [{ appId: disposableAppId("android", "feedly"), reason: "expired" }],
      skipped: [],
    });
    expect(installer.uninstalls).toEqual([disposableAppId("android", "feedly")]);
    expect((await manager.list(DEVICE, "android")).map((entry) => entry.appId)).toEqual([
      disposableAppId("android", "keeper"),
      disposableAppId("android", "later"),
    ]);
  });

  test("listApps joins the registry with prefixed device packages", async () => {
    await manager.install(input());
    const stray = disposableAppId("android", "stray");
    installer.seed(DEVICE, stray, "host-key");
    installer.seed(DEVICE, "com.example.real", "other");
    expect(await manager.list(DEVICE, "android")).toEqual([
      expect.objectContaining({ appId: disposableAppId("android", "feedly"), registered: true }),
      { appId: stray, registered: false, installed: true, expired: false },
    ]);
  });

  test("uninstall refuses ids outside the prefix and packages signed by another key", async () => {
    await expect(
      manager.uninstall(DEVICE, "android", { appId: "com.example.real" }),
    ).rejects.toThrow(/not a disposable/);
    const foreign = disposableAppId("android", "foreign");
    installer.seed(DEVICE, foreign, "someone-else");
    await expect(manager.uninstall(DEVICE, "android", { appId: foreign })).rejects.toThrow(
      /not signed by this host's disposable-app key/,
    );
    await manager.install(input());
    const all = await manager.uninstall(DEVICE, "android", { all: true });
    expect(all.removed.map((entry) => entry.appId)).toEqual([disposableAppId("android", "feedly")]);
    expect(all.skipped.map((entry) => entry.appId)).toEqual([foreign]);
    expect(installer.uninstalls).toEqual([disposableAppId("android", "feedly")]);
  });

  test("uninstalling an app that is gone from the device still clears its registry entry", async () => {
    await manager.install(input());
    const appId = disposableAppId("android", "feedly");
    installer.packages.clear();
    expect(await manager.uninstall(DEVICE, "android", { appId })).toEqual({
      removed: [{ appId, reason: "requested" }],
      skipped: [],
    });
    expect(installer.uninstalls).toEqual([]);
    expect(await registry.list(DEVICE)).toEqual([]);
  });

  test("bulk removal refuses registry records outside the reserved prefix", async () => {
    await registry.put(DEVICE, {
      appId: "com.example.real",
      slug: "real",
      platform: "android",
      label: "Real",
      specSha256: "a".repeat(64),
      template: "base",
      signer: "host-key",
      installedAt: 0,
      expiresAt: 1,
    });
    installer.seed(DEVICE, "com.example.real", undefined);
    timer.advanceTime(2);
    const swept = await manager.sweepExpired(DEVICE, "android");
    expect(swept.removed).toEqual([]);
    expect(swept.skipped.map((entry) => entry.appId)).toEqual(["com.example.real"]);
    expect(installer.uninstalls).toEqual([]);
  });

  test("a same-slug reinstall during an expiry sweep survives the sweep", async () => {
    await manager.install(input({ ttlHours: 1 }));
    timer.advanceTime(HOUR);
    let release: () => void = () => undefined;
    installer.inspectGate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const paused = new Promise<void>((resolve) => {
      installer.onInspect = resolve;
    });
    const sweep = manager.sweepExpired(DEVICE, "android");
    await paused;
    const reinstall = manager.install(input({ ttlHours: 0 }));
    // Let the reinstall run as far as it can while the sweep is paused mid-removal.
    await new Promise<void>((resolve) => setImmediate(resolve));
    installer.inspectGate = undefined;
    release();
    await sweep;
    await reinstall;
    const appId = disposableAppId("android", "feedly");
    expect(await manager.list(DEVICE, "android")).toEqual([
      expect.objectContaining({ appId, installed: true, expiresAt: null }),
    ]);
  });
});
