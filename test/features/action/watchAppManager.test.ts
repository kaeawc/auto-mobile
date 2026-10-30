import { describe, expect, test } from "bun:test";
import path from "node:path";
import { DAEMON_LAUNCH_CWD_ENV } from "../../../src/utils/workingDirectory";
import { WatchAppManager } from "../../../src/features/action/watch/WatchAppManager";
import { ActionableError, type BootedDevice } from "../../../src/models";
import { FakeWatchAppsSimctl, FakeWatchBundleIds } from "../../fakes/FakeWatchApps";

// installApp/uninstallApp on an Apple Watch simulator run simctl on the watch's UDID only (#14908).

const watch: BootedDevice = {
  name: "Apple Watch Series 10 (46mm)",
  deviceId: "6B1F3C2E-0000-4000-8000-00000000A7C1",
  platform: "watchos",
};
const APP = "/build/Debug-watchsimulator/Workout.app";
const BUNDLE = "com.example.workout.watchkitapp";

function arrange() {
  const plist = new FakeWatchBundleIds();
  plist.byPath.set(APP, BUNDLE);
  const simctl = new FakeWatchAppsSimctl(plist);
  return { simctl, plist, apps: new WatchAppManager(watch, { simctl, plist }) };
}

const installed = async (apps: WatchAppManager) =>
  (await apps.listRecords()).map((record) => record.CFBundleIdentifier);

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("WatchAppManager", () => {
  test("install, then uninstall, a .app bundle on the watch's own UDID", async () => {
    const { simctl, apps } = arrange();

    expect(await apps.install(APP)).toEqual({
      success: true,
      artifactPath: APP,
      packageName: BUNDLE,
      upgrade: false,
    });
    expect(await installed(apps)).toEqual([BUNDLE]);

    expect(await apps.uninstall(BUNDLE)).toEqual({
      success: true,
      packageName: BUNDLE,
      keepData: false,
      wasInstalled: true,
    });
    expect(await installed(apps)).toEqual([]);
    expect(simctl.commands).toEqual([
      `install ${watch.deviceId} ${APP}`,
      `uninstall ${watch.deviceId} ${BUNDLE}`,
    ]);
  });

  test("a relative bundle path resolves against the daemon launch directory", async () => {
    const plist = new FakeWatchBundleIds();
    const launched = `/launch-dir/${APP.slice(1)}`;
    plist.byPath.set(launched, BUNDLE);
    const simctl = new FakeWatchAppsSimctl(plist);
    const fromLaunchDir = (artifactPath: string) =>
      artifactPath.startsWith("/") ? artifactPath : `/launch-dir/${artifactPath}`;
    const apps = new WatchAppManager(watch, { simctl, plist, resolveArtifactPath: fromLaunchDir });

    expect(await apps.install(APP.slice(1))).toMatchObject({
      success: true,
      artifactPath: launched,
      packageName: BUNDLE,
    });
    expect(plist.reads).toEqual([`CFBundleIdentifier ${launched}/Info.plist`]);
    expect(simctl.commands).toEqual([`install ${watch.deviceId} ${launched}`]);
  });

  test("a reinstall of a listed bundle reports upgrade", async () => {
    const { apps } = arrange();
    await apps.install(APP);

    expect(await apps.install(`${APP}/`)).toMatchObject({ packageName: BUNDLE, upgrade: true });
  });

  test("uninstalling an app that is not installed runs no simctl uninstall", async () => {
    const { simctl, apps } = arrange();

    expect(await apps.uninstall(BUNDLE)).toMatchObject({ success: true, wasInstalled: false });
    expect(simctl.commands).toEqual([]);
  });

  test.each(["/build/Workout.ipa", "/build/app-debug.apk", "/build/app.aab", "/build/app.apks"])(
    "refuses %s before any simctl or plist call",
    async (artifact) => {
      const { simctl, plist, apps } = arrange();

      const error = await rejection(apps.install(artifact));

      expect(error).toBeInstanceOf(ActionableError);
      expect(String(error)).toContain("needs a .app bundle built for the watchOS simulator");
      expect(simctl.commands).toEqual([]);
      expect(plist.reads).toEqual([]);
    },
  );

  test("names every Android-only install option it refuses", async () => {
    const { simctl, apps } = arrange();

    const error = await rejection(
      apps.install(APP, {
        android: { splits: ["/split.apk"], grantAllPermissions: true },
        guard: { expectedSigningSha256: ["ab"], allowDestructiveRecovery: false },
      }),
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain(
      "does not support: splits, grantAllPermissions, expectedSigningSha256, allowDestructiveRecovery",
    );
    expect(simctl.commands).toEqual([]);
  });

  test("refuses a bundle whose Info.plist has no readable CFBundleIdentifier", async () => {
    const { simctl, apps } = arrange();

    const error = await rejection(apps.install("/build/Unknown.app"));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("Could not read CFBundleIdentifier from /build/Unknown.app");
    expect(simctl.commands).toEqual([]);
  });

  test("a failed listing stops the install instead of guessing upgrade", async () => {
    const { simctl, apps } = arrange();
    simctl.listingError = new Error("simctl listapps timed out");

    expect(String(await rejection(apps.install(APP)))).toContain("simctl listapps timed out");
    expect(simctl.commands).toEqual([]);
  });

  test("refuses keepData: simctl uninstall always removes app data", async () => {
    const { simctl, apps } = arrange();
    await apps.install(APP);

    const error = await rejection(apps.uninstall(BUNDLE, { keepData: true }));

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("cannot keep app data");
    expect(await installed(apps)).toEqual([BUNDLE]);
    expect(simctl.commands).toEqual([`install ${watch.deviceId} ${APP}`]);
  });

  test("refuses every Android-only uninstall option it was given, by name", async () => {
    const { apps } = arrange();

    const guard = await rejection(
      apps.uninstall(BUNDLE, { guard: { expectedSigningSha256: ["ab"] } }),
    );
    const both = await rejection(
      apps.uninstall(BUNDLE, { guard: { expectedSigningSha256: ["ab"] }, userId: 10 }),
    );

    expect(String(guard)).toContain("does not support: expectedSigningSha256 (Android only)");
    expect(String(both)).toContain("does not support: expectedSigningSha256, userId");
  });

  test("the default resolver anchors a relative bundle path at the daemon launch directory", async () => {
    const relative = APP.slice(1);
    const launched = path.resolve("/launch-dir", relative);
    const previous = process.env[DAEMON_LAUNCH_CWD_ENV];
    process.env[DAEMON_LAUNCH_CWD_ENV] = "/launch-dir";
    try {
      const plist = new FakeWatchBundleIds();
      plist.byPath.set(launched, BUNDLE);
      const simctl = new FakeWatchAppsSimctl(plist);

      expect(await new WatchAppManager(watch, { simctl, plist }).install(relative)).toMatchObject({
        artifactPath: launched,
        packageName: BUNDLE,
      });
      expect(simctl.commands).toEqual([`install ${watch.deviceId} ${launched}`]);
    } finally {
      if (previous === undefined) {
        delete process.env[DAEMON_LAUNCH_CWD_ENV];
      } else {
        process.env[DAEMON_LAUNCH_CWD_ENV] = previous;
      }
    }
  });
});
