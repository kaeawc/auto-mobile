import { describe, expect, test } from "bun:test";
import { WatchAppManager } from "../../../src/features/action/watch/WatchAppManager";
import { PACKAGE_NOT_INSTALLED_ERROR } from "../../../src/features/action/LaunchPackageRemovedError";
import { ActionableError, type BootedDevice } from "../../../src/models";
import { FakeWatchAppsSimctl, FakeWatchBundleIds } from "../../fakes/FakeWatchApps";
import {
  simulatorDataContainer,
  simulatorOwnership,
} from "../../helpers/simulatorContainerFixture";

// launchApp/terminateApp on an Apple Watch simulator run simctl on the watch's UDID only, and
// clearAppData wipes the app's data container on that watch before the launch (#14908).

const watch: BootedDevice = {
  name: "Apple Watch Series 10 (46mm)",
  deviceId: "6B1F3C2E-0000-4000-8000-00000000A7C1",
  platform: "watchos",
};
const UDID = watch.deviceId;
const APP = "/build/Debug-watchsimulator/Workout.app";
const BUNDLE = "com.example.workout.watchkitapp";
const LAUNCH = { clearAppData: false, coldBoot: false };

async function arrange({ install = true } = {}) {
  const plist = new FakeWatchBundleIds();
  plist.byPath.set(APP, BUNDLE);
  const simctl = new FakeWatchAppsSimctl(plist);
  const removed: string[] = [];
  const apps = new WatchAppManager(watch, simctl, plist, undefined, {
    containerOwnership: simulatorOwnership,
    rm: async (path) => {
      removed.push(String(path));
    },
  });
  if (install) {
    await apps.install(APP);
  }
  simctl.commands.length = 0;
  return { simctl, apps, removed };
}

async function rejection(promise: Promise<unknown>): Promise<unknown> {
  return await promise.then(
    () => undefined,
    (error: unknown) => error,
  );
}

describe("WatchAppManager launch", () => {
  test("launches an installed app on the watch and reports its pid", async () => {
    const { simctl, apps } = await arrange();

    const result = await apps.launch(BUNDLE, { ...LAUNCH, launchArguments: ["-demo", "1"] });

    expect(result).toEqual({ success: true, packageName: BUNDLE, pid: simctl.pidOf(UDID, BUNDLE) });
    expect(result.pid).toBeNumber();
    expect(simctl.commands).toEqual([`launch ${UDID} ${BUNDLE} -demo 1`]);
  });

  test("an app that is not installed is reported, and nothing is launched", async () => {
    const { simctl, apps } = await arrange({ install: false });

    expect(await apps.launch(BUNDLE, LAUNCH)).toEqual({
      success: false,
      packageName: BUNDLE,
      error: PACKAGE_NOT_INSTALLED_ERROR,
    });
    expect(simctl.commands).toEqual([]);
  });

  test("coldBoot stops the running app before launching a new process", async () => {
    const { simctl, apps } = await arrange();
    const first = await apps.launch(BUNDLE, LAUNCH);

    const cold = await apps.launch(BUNDLE, { ...LAUNCH, coldBoot: true });

    expect(cold.pid).not.toBe(first.pid);
    expect(simctl.commands.slice(1)).toEqual([
      `terminate ${UDID} ${BUNDLE}`,
      `launch ${UDID} ${BUNDLE}`,
    ]);
  });

  test("coldBoot of an app that is not running still launches it", async () => {
    const { simctl, apps } = await arrange();

    expect(await apps.launch(BUNDLE, { ...LAUNCH, coldBoot: true })).toMatchObject({
      success: true,
    });
    expect(simctl.pidOf(UDID, BUNDLE)).toBeNumber();
  });

  test("clearAppData stops the app and wipes its data container on the watch before launching", async () => {
    const { simctl, apps, removed } = await arrange();
    const before = await apps.launch(BUNDLE, LAUNCH);

    const result = await apps.launch(BUNDLE, { ...LAUNCH, clearAppData: true });

    const container = simulatorDataContainer(UDID);
    expect(removed.sort()).toEqual(
      ["Documents", "Library", "tmp"].map((folder) => `${container}/${folder}`),
    );
    expect(simctl.commands.slice(1)).toEqual([
      `terminate ${UDID} ${BUNDLE}`,
      `get_app_container ${UDID} ${BUNDLE} data`,
      `launch ${UDID} ${BUNDLE}`,
    ]);
    expect(result).toMatchObject({ success: true, packageName: BUNDLE });
    expect(result.pid).not.toBe(before.pid);
  });

  test("a failed data wipe is reported, and the app is not launched", async () => {
    const { simctl } = await arrange();
    const failing = new WatchAppManager(watch, simctl, new FakeWatchBundleIds(), undefined, {
      containerOwnership: simulatorOwnership,
      rm: async () => {
        throw new Error("EACCES: permission denied");
      },
    });

    const result = await failing.launch(BUNDLE, { ...LAUNCH, clearAppData: true });

    expect(result).toMatchObject({ success: false, packageName: BUNDLE });
    expect(result.error).toContain("EACCES: permission denied");
    expect(simctl.commands.some((command) => command.startsWith("launch"))).toBe(false);
  });

  test("a simctl launch failure is reported as a failed launch", async () => {
    const { simctl, apps } = await arrange();
    simctl.launchError = "FBSOpenApplicationServiceErrorDomain error 1";

    expect(await apps.launch(BUNDLE, LAUNCH)).toEqual({
      success: false,
      packageName: BUNDLE,
      error: "FBSOpenApplicationServiceErrorDomain error 1",
    });
  });

  test("names every Android-only launch option it refuses, before any simctl call", async () => {
    const { simctl, apps } = await arrange();

    const error = await rejection(
      apps.launch(BUNDLE, {
        ...LAUNCH,
        intent: { action: "android.intent.action.VIEW" },
        activityName: ".Main",
        userId: 10,
      }),
    );

    expect(error).toBeInstanceOf(ActionableError);
    expect(String(error)).toContain("does not support: intent, activityName, userId");
    expect(simctl.commands).toEqual([]);
  });

  test("a failed app listing throws instead of reporting the app as not installed", async () => {
    const { simctl, apps } = await arrange();
    simctl.listingError = new Error("simctl listapps: device is not booted");

    expect(String(await rejection(apps.launch(BUNDLE, LAUNCH)))).toContain("not booted");
    expect(simctl.commands).toEqual([]);
  });
});

describe("WatchAppManager terminate", () => {
  test("terminates a running app on the watch", async () => {
    const { simctl, apps } = await arrange();
    await apps.launch(BUNDLE, LAUNCH);

    expect(await apps.terminate(BUNDLE)).toEqual({
      success: true,
      packageName: BUNDLE,
      wasInstalled: true,
      wasRunning: true,
    });
    expect(simctl.pidOf(UDID, BUNDLE)).toBeUndefined();
  });

  test("an installed app that is not running is already terminated", async () => {
    const { apps } = await arrange();

    expect(await apps.terminate(BUNDLE)).toEqual({
      success: true,
      packageName: BUNDLE,
      wasInstalled: true,
      wasRunning: false,
      wasForeground: false,
    });
  });

  test("an app that is not installed runs no simctl terminate", async () => {
    const { simctl, apps } = await arrange({ install: false });

    expect(await apps.terminate(BUNDLE)).toEqual({
      success: true,
      packageName: BUNDLE,
      wasInstalled: false,
      wasRunning: false,
      wasForeground: false,
    });
    expect(simctl.commands).toEqual([]);
  });

  test("any other simctl failure is a failed termination", async () => {
    const { simctl, apps } = await arrange();
    await apps.launch(BUNDLE, LAUNCH);
    simctl.terminateError = new Error("Unable to terminate: device is shutting down");

    expect(await apps.terminate(BUNDLE)).toEqual({
      success: false,
      packageName: BUNDLE,
      error: "Unable to terminate: device is shutting down",
    });
  });
});
