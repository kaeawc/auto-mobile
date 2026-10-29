import { describe, expect, test } from "bun:test";
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
  return { simctl, plist, apps: new WatchAppManager(watch, simctl, plist) };
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

  test("refuses the Android-only uninstall signing guard by name", async () => {
    const { apps } = arrange();

    const error = await rejection(
      apps.uninstall(BUNDLE, { guard: { expectedSigningSha256: ["ab"] } }),
    );

    expect(String(error)).toContain("does not support: expectedSigningSha256");
  });
});
