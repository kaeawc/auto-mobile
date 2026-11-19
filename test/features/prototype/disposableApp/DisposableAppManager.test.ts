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
import { ActionableError } from "../../../../src/models/ActionableError";
import type { PrototypeJson } from "../../../../src/features/prototype/prototypeJson";

const HOUR = 60 * 60 * 1000;
const DEVICE = "emulator-5554";
const media = {
  name: "media",
  capabilities: [
    "prototype_platform_v1",
    "prototype_platform_test_v1",
    "prototype_platform_location_v1",
  ],
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
  test("refuses an undeclared call permission before stamping or installing", async () => {
    const requires = {
      platform: fixture.requires.platform,
      background: fixture.requires.background,
    };
    const spec = { ...fixture, requires };
    const installation = manager.install({ ...input(), spec });
    await expect(installation).rejects.toBeInstanceOf(ActionableError);
    await expect(installation).rejects.toThrow(
      /root\.onTap\[0\]\.call: .*camera.*declare it in requires.permissions/,
    );
    expect(stamper.stamped).toEqual([]);
    expect(installer.installs).toEqual([]);
  });

  const cameraNodes: Record<string, PrototypeJson>[] = [
    { root: { type: "cameraPreview", id: "preview" } },
    {
      components: { preview: { root: { type: "cameraPreview", id: "preview" } } },
      root: { type: "use", component: "preview" },
    },
  ];
  test.each(cameraNodes)(
    "refuses undeclared camera permission in a node before installation: %j",
    async (nodes) => {
      const spec = { ...fixture, ...nodes, requires: { platform: ["camera"] } };
      await expect(manager.install({ ...input(), spec })).rejects.toThrow(
        /camera.*declare it in requires.permissions/,
      );
      expect(stamper.stamped).toEqual([]);
      expect(installer.installs).toEqual([]);
    },
  );

  test("stamps exactly the declared call permission's manifest entries plus INTERNET", async () => {
    await manager.install({
      ...input(),
      spec: {
        ...fixture,
        requires: {
          platform: ["location"],
          permissions: [{ name: "location", purpose: "Show the current position" }],
        },
        root: {
          type: "button",
          label: "Locate",
          onTap: [{ type: "platform", call: "location.request" }],
        },
      },
    });
    expect(stamper.stamped[0]?.declarations).toEqual({
      permissions: ["location"],
      background: [],
      android: {
        permissions: [
          "android.permission.ACCESS_COARSE_LOCATION",
          "android.permission.ACCESS_FINE_LOCATION",
          "android.permission.INTERNET",
        ],
      },
      ios: {
        usageDescriptions: { NSLocationWhenInUseUsageDescription: "Show the current position" },
        backgroundModes: [],
      },
    });
    expect(installer.installs).toHaveLength(1);
  });

  test("a spec declaring nothing stamps only INTERNET and no iOS usage descriptions", async () => {
    await manager.install({
      ...input(),
      spec: { id: "plain", window: fixture.window, root: { type: "column" } },
    });
    expect(stamper.stamped[0]?.declarations).toEqual({
      permissions: [],
      background: [],
      android: { permissions: ["android.permission.INTERNET"] },
      ios: { usageDescriptions: {}, backgroundModes: [] },
    });
  });

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
    expect(installer.installs).toHaveLength(2);
    expect(installer.resets).toEqual([disposableAppId("android", "feedly")]);
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

  test("a reinstall whose storage reset fails still records the new expiry", async () => {
    await manager.install(input({ ttlHours: 1 }));
    timer.advanceTime(HOUR);
    installer.resetFailure = new Error("pm clear failed");
    const appId = disposableAppId("android", "feedly");
    await expect(manager.install(input({ ttlHours: 0, reset: true }))).rejects.toThrow(
      `${appId} is installed on ${DEVICE} (expires never), but its storage was not cleared: pm clear failed.`,
    );
    expect(await registry.list(DEVICE)).toEqual([
      expect.objectContaining({ appId, installedAt: HOUR, expiresAt: null }),
    ]);
    expect(installer.grants).toHaveLength(1);
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
  test("sweeps empty and unexpired registries without querying Android packages", async () => {
    class InstallerWithoutPackageReads extends FakeDisposableAppInstaller {
      override async installedIds(): Promise<string[]> {
        throw new Error("Unexpected package listing");
      }

      override async inspect(): Promise<never> {
        throw new Error("Unexpected package inspection");
      }
    }
    const sweeper = new DisposableAppManager({
      platforms: { android: { stamper, installer: new InstallerWithoutPackageReads() } },
      registry,
      timer,
    });
    expect(await sweeper.sweepExpired(DEVICE, "android")).toEqual({ removed: [], skipped: [] });
    await manager.install(input({ ttlHours: 1 }));
    expect(await sweeper.sweepExpired(DEVICE, "android")).toEqual({ removed: [], skipped: [] });
  });

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

  test("bulk removal stops at its deadline and returns the rest as pending", async () => {
    const bounded = new DisposableAppManager({
      platforms: { android: { stamper, installer } },
      registry,
      timer,
      bulkUninstallBudgetMs: 3_000,
      uninstallStepMs: 1_000,
    });
    for (const slug of ["a", "b", "c", "d", "e"]) {
      await bounded.install(input({ slug }));
    }
    const ids = ["a", "b", "c", "d", "e"].map((slug) => disposableAppId("android", slug)).sort();
    installer.onUninstall = () => timer.advanceTime(1_000);
    const first = await bounded.uninstall(DEVICE, "android", { all: true });
    expect(first.removed.map((entry) => entry.appId)).toEqual(ids.slice(0, 3));
    expect(first.pending).toEqual(ids.slice(3));
    const rest = await bounded.uninstall(DEVICE, "android", { all: true });
    expect(rest).toEqual({
      removed: ids.slice(3).map((appId) => ({ appId, reason: "all" })),
      skipped: [],
    });
  });

  test("a bulk retry tries apps it skipped last, so it reaches the pending ones", async () => {
    const bounded = new DisposableAppManager({
      platforms: { android: { stamper, installer } },
      registry,
      timer,
      bulkUninstallBudgetMs: 2_000,
      uninstallStepMs: 1_000,
    });
    const foreign = ["a", "b"].map((slug) => disposableAppId("android", slug)).sort();
    for (const appId of foreign) {
      installer.seed(DEVICE, appId, "someone-else");
    }
    await bounded.install(input({ slug: "z" }));
    const owned = disposableAppId("android", "z");
    installer.onInspect = () => timer.advanceTime(1_000);
    const first = await bounded.uninstall(DEVICE, "android", { all: true });
    expect(first.skipped.map((entry) => entry.appId)).toEqual(foreign);
    expect(first.pending).toEqual([owned]);
    const retry = await bounded.uninstall(DEVICE, "android", { all: true });
    expect(retry.removed).toEqual([{ appId: owned, reason: "all" }]);
    expect(retry.pending).toEqual([foreign[1]]);
    expect(installer.uninstalls).toEqual([owned]);
  });

  test("bulk removal always starts one app, and fast removals all fit", async () => {
    const tight = new DisposableAppManager({
      platforms: { android: { stamper, installer } },
      registry,
      timer,
      bulkUninstallBudgetMs: 10,
      uninstallStepMs: 1_000,
    });
    await tight.install(input({ slug: "a", ttlHours: 1 }));
    await tight.install(input({ slug: "b", ttlHours: 1 }));
    timer.advanceTime(HOUR);
    installer.onUninstall = () => timer.advanceTime(1);
    const swept = await tight.uninstall(DEVICE, "android", { expired: true });
    expect(swept.removed).toHaveLength(1);
    expect(swept.pending).toEqual([disposableAppId("android", "b")]);
    installer.onUninstall = undefined;
    const fast = await manager.uninstall(DEVICE, "android", { expired: true });
    expect(fast.removed.map((entry) => entry.appId)).toEqual([disposableAppId("android", "b")]);
    expect(fast.pending).toBeUndefined();
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

test("generates one attach token per app and keeps it private on reinstall", async () => {
  let generated = 0;
  const token = "b".repeat(64);
  const apps = new DisposableAppManager({
    platforms: { android: { stamper, installer } },
    registry,
    timer,
    attachTokens: {
      next: () => {
        generated++;
        return token;
      },
    },
  });
  const first = await apps.install(input());
  const second = await apps.install(input());
  expect(generated).toBe(1);
  expect(stamper.stamped.map((value) => value.attachToken)).toEqual([token, token]);
  expect((await registry.list(DEVICE))[0]).toMatchObject({
    specId: fixture.id,
    attachToken: token,
  });
  expect(JSON.stringify([first, second, await apps.list(DEVICE, "android")])).not.toContain(token);
});
