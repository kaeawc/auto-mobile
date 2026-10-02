import { afterEach, describe, expect, spyOn, test } from "bun:test";
import { ClearAppData } from "../../../src/features/action/ClearAppData";
import { InstallApp } from "../../../src/features/action/InstallApp";
import { AndroidCtrlProxyClient } from "../../../src/features/observe/android";
import type { BootedDevice, ExecResult, ObserveResult } from "../../../src/models";
import { createPerformanceTracker } from "../../../src/utils/PerformanceTracker";
import { SimCtlClient } from "../../../src/utils/ios-cmdline-tools/SimCtlClient";
import {
  resolveIosClearDataBackend,
  type IosInstallBackend,
} from "../../../src/utils/ios-cmdline-tools/IosDeviceBackend";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeAndroidBuildToolsLocator } from "../../fakes/FakeAndroidBuildToolsLocator";
import { FakeDeviceWindowCacheInvalidator } from "../../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeHostCommandExecutor } from "../../fakes/FakeHostCommandExecutor";
import { FakeInstalledAppsRepository } from "../../fakes/FakeInstalledAppsRepository";
import { FakeObserveCacheStore } from "../../fakes/FakeObserveCacheStore";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const android: BootedDevice = { name: "android", platform: "android", deviceId: "test-android" };
const simulator: BootedDevice = {
  name: "sim",
  platform: "ios",
  deviceId: "AAAAAAAA-BBBB-CCCC-DDDD-EEEEEEEEEEEE",
};
const physical: BootedDevice = {
  name: "phone",
  platform: "ios",
  deviceId: "00008030-001A2B3C0E11002E",
};
const appId = "com.example.app";
const execResult = (stdout: string): ExecResult => ({
  stdout,
  stderr: "",
  toString: () => stdout,
  trim: () => stdout.trim(),
  includes: (value) => stdout.includes(value),
});
const staleResult = (timer: FakeTimer): ObserveResult => ({
  updatedAt: timer.now(),
  screenSize: { width: 100, height: 100 },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  viewHierarchy: { node: {} },
});

class OrderedAdb extends FakeAdbExecutor {
  constructor(private readonly events: string[]) {
    super();
  }
  override async executeCommand(
    ...args: Parameters<FakeAdbExecutor["executeCommand"]>
  ): Promise<ExecResult> {
    const command = args[0];
    this.events.push(`issued:${command}`);
    try {
      return await super.executeCommand(...args);
    } finally {
      this.events.push(`settled:${command}`);
    }
  }
}

function clearInvalidationHarness(events: string[]) {
  const store = new FakeObserveCacheStore(new FakeTimer());
  const invalidator = new FakeDeviceWindowCacheInvalidator((device) => {
    store.clear(device.deviceId);
    events.push("invalidate");
  });
  return { invalidator, store };
}

function androidInstallHarness(output = "Success") {
  const events: string[] = [];
  const adb = new OrderedAdb(events);
  adb.setCommandResponse("shell pm list packages --user 0", execResult(`package:${appId}`));
  adb.setCommandResponse("install --user 0 -r", execResult(output));
  const host = new FakeHostCommandExecutor();
  host.setCommandResponse("aapt2", execResult(`package: name='${appId}' versionCode='1'`));
  const tools = new FakeAndroidBuildToolsLocator();
  tools.setTool({ tool: "aapt2", path: "/fake/aapt2" });
  const timer = new FakeTimer();
  const makeAction = (invalidator: FakeDeviceWindowCacheInvalidator) =>
    new InstallApp(
      android,
      { create: () => adb },
      host,
      tools,
      () => createPerformanceTracker(false, timer),
      null,
      null,
      undefined,
      new FakeInstalledAppsRepository(),
      undefined,
      timer,
      undefined,
      invalidator,
    );
  return { events, adb, timer, makeAction };
}

function iosInstallHarness(device = simulator, downgrade = false) {
  const timer = new FakeTimer();
  const events: string[] = [];
  let installed = false;
  let attempts = 0;
  const backend: IosInstallBackend = {
    kind: device === simulator ? "simulator" : "physical",
    installApp: async () => {
      attempts++;
      events.push("install");
      if (downgrade && attempts === 1) {
        events.push("failed");
        throw new Error("version downgrade");
      }
      installed = true;
      events.push("installed");
    },
    listApps: async () => (installed ? [{ bundleId: appId }] : []),
  };
  const simctl = new SimCtlClient(
    device,
    async (_file, args) => {
      events.push(args[1]);
      return execResult("");
    },
    timer,
  );
  const plist = {
    extractString: async () => appId,
    readXmlBytes: async () => "",
    extractRawFile: async () => appId,
  };
  const makeAction = (invalidator: FakeDeviceWindowCacheInvalidator) =>
    new InstallApp(
      device,
      { create: () => new FakeAdbExecutor() },
      new FakeHostCommandExecutor(),
      new FakeAndroidBuildToolsLocator(),
      () => createPerformanceTracker(false, timer),
      simctl,
      null,
      plist,
      new FakeInstalledAppsRepository(),
      undefined,
      timer,
      () => backend,
      invalidator,
    );
  return { events, makeAction };
}

describe("app restart cache generation", () => {
  // The installed-app query falls back to the fake ADB; never connect to a device.
  let proxySpy: ReturnType<typeof spyOn> | undefined;
  afterEach(() => {
    proxySpy?.mockRestore();
  });
  function fakeAndroidProxy() {
    proxySpy = spyOn(AndroidCtrlProxyClient, "getInstance").mockImplementation(() => {
      throw new Error("fake proxy unavailable");
    });
  }

  test.each(["Success", "Failed", "throw"])(
    "pm clear invalidates after command settlement (%s)",
    async (output) => {
      const events: string[] = [];
      const adb = new OrderedAdb(events);
      if (output === "throw") {
        adb.setCommandError("shell pm clear", new Error("partially cleared"));
      } else {
        adb.setCommandResponse("shell pm clear", execResult(output));
      }
      const { invalidator, store } = clearInvalidationHarness(events);
      const result = await new ClearAppData(
        android,
        { create: () => adb },
        { cacheInvalidator: invalidator },
      ).execute(appId, 0);
      expect(result.success).toBe(output === "Success");
      expect(invalidator.calls).toEqual([android]);
      expect(store.currentGeneration(android.deviceId)).toBe(1);
      expect(events).toEqual([
        `issued:shell pm clear --user 0 '${appId}'`,
        `settled:shell pm clear --user 0 '${appId}'`,
        "invalidate",
      ]);
    },
  );

  test.each([simulator, physical])(
    "iOS clear invalidates after the backend completes on $name",
    async (device) => {
      for (const fails of [false, true]) {
        const events: string[] = [];
        const simctl = new FakeSimCtlClient();
        simctl.setContainerPath(appId, "/fake/container");
        const { invalidator, store } = clearInvalidationHarness(events);
        const action = new ClearAppData(device, undefined, {
          cacheInvalidator: invalidator,
          backendResolver: (id, deps) =>
            resolveIosClearDataBackend(id, {
              ...deps,
              simctl,
              rm: async () => {
                events.push("wipe");
                if (fails) {
                  throw new Error("partial wipe");
                }
              },
              createReinstaller: () => ({
                clearAppDataViaReinstall: async () => {
                  events.push("reinstall");
                  if (fails) {
                    throw new Error("partial reinstall");
                  }
                },
              }),
            }),
        });
        expect((await action.execute(appId)).success).toBe(!fails);
        expect(invalidator.calls).toEqual([device]);
        expect(store.currentGeneration(device.deviceId)).toBe(1);
        expect(events.at(-1)).toBe("invalidate");
        expect(events[0]).toBe(device === simulator ? "wipe" : "reinstall");
        if (device === simulator) {
          expect(simctl.getMethodCalls("terminateApp")).toEqual([
            { bundleId: appId, deviceId: device.deviceId },
          ]);
        }
      }
    },
  );

  test("iOS clear invalidates after a backend rejects", async () => {
    const events: string[] = [];
    const { invalidator, store } = clearInvalidationHarness(events);
    const action = new ClearAppData(simulator, undefined, {
      cacheInvalidator: invalidator,
      backendResolver: () => ({
        kind: "simulator",
        clearAppData: async () => {
          events.push("clear");
          throw new Error("partial clear");
        },
      }),
    });
    await expect(action.execute(appId)).rejects.toThrow("partial clear");
    expect(events).toEqual(["clear", "invalidate"]);
    expect(invalidator.calls).toEqual([simulator]);
    expect(store.currentGeneration(simulator.deviceId)).toBe(1);
  });

  test("Android replacement invalidates immediately after successful -r install", async () => {
    fakeAndroidProxy();
    const h = androidInstallHarness();
    const invalidator = new FakeDeviceWindowCacheInvalidator(() => h.events.push("invalidate"));
    expect((await h.makeAction(invalidator).execute("/fake/app.apk", 0)).success).toBe(true);
    expect(invalidator.calls).toEqual([android]);
    const index = h.events.indexOf("invalidate");
    expect(h.events[index - 1]).toBe('settled:install --user 0 -r "/fake/app.apk"');
  });

  test.each([true, false])(
    "Android downgrade fences uninstall and successful reinstall (reinstall succeeds=%s)",
    async (succeeds) => {
      fakeAndroidProxy();
      const h = androidInstallHarness();
      h.adb.setCommandResponseSequence("install --user 0 -r", [
        execResult("Failure [INSTALL_FAILED_VERSION_DOWNGRADE]"),
        execResult(succeeds ? "Success" : "Failure [INSTALL_FAILED_INVALID_APK]"),
      ]);
      h.adb.setCommandResponse("uninstall ", execResult("Success"));
      const invalidator = new FakeDeviceWindowCacheInvalidator(() => h.events.push("invalidate"));
      expect((await h.makeAction(invalidator).execute("/fake/app.apk", 0)).success).toBe(succeeds);
      expect(invalidator.calls).toEqual(succeeds ? [android, android] : [android]);
      const preceding = h.events.flatMap((event, i) =>
        event === "invalidate" ? [h.events[i - 1]] : [],
      );
      expect(preceding).toEqual(
        succeeds
          ? [`settled:uninstall ${appId}`, 'settled:install --user 0 -r "/fake/app.apk"']
          : [`settled:uninstall ${appId}`],
      );
    },
  );

  test.each(["Failure [INSTALL_FAILED_INVALID_APK]", "throw"])(
    "failed install does not invalidate (%s)",
    async (output) => {
      fakeAndroidProxy();
      const h = androidInstallHarness(output);
      const invalidator = new FakeDeviceWindowCacheInvalidator();
      if (output === "throw") {
        h.adb.setCommandError("install --user", new Error("install failed"));
        await expect(h.makeAction(invalidator).execute("/fake/app.apk", 0)).rejects.toThrow(
          "install failed",
        );
      } else {
        expect((await h.makeAction(invalidator).execute("/fake/app.apk", 0)).success).toBe(false);
      }
      expect(invalidator.calls).toEqual([]);
    },
  );

  test.each([simulator, physical])(
    "iOS successful install invalidates on $name",
    async (device) => {
      const h = iosInstallHarness(device);
      const invalidator = new FakeDeviceWindowCacheInvalidator(() => h.events.push("invalidate"));
      expect(
        (
          await h
            .makeAction(invalidator)
            .execute(device === simulator ? "/fake/app.app" : "/fake/app.ipa")
        ).success,
      ).toBe(true);
      expect(invalidator.calls).toEqual([device]);
      expect(h.events).toEqual(["install", "installed", "invalidate"]);
    },
  );

  test("iOS simulator downgrade fences uninstall and reinstall", async () => {
    const h = iosInstallHarness(simulator, true);
    const invalidator = new FakeDeviceWindowCacheInvalidator(() => h.events.push("invalidate"));
    expect((await h.makeAction(invalidator).execute("/fake/app.app")).success).toBe(true);
    expect(invalidator.calls).toEqual([simulator, simulator]);
    expect(h.events).toEqual([
      "install",
      "failed",
      "terminate",
      "uninstall",
      "invalidate",
      "install",
      "installed",
      "invalidate",
    ]);
  });

  test.each(["clear", "install"])(
    "%s rejects a pre-action observation, while the no-op control caches it",
    async (path) => {
      fakeAndroidProxy();
      for (const fence of [true, false]) {
        const h = androidInstallHarness();
        const store = new FakeObserveCacheStore(h.timer);
        const generation = store.currentGeneration(android.deviceId);
        const stale = staleResult(h.timer);
        const invalidator = new FakeDeviceWindowCacheInvalidator((device) => {
          if (fence) {
            store.clear(device.deviceId);
          }
        });
        h.adb.setCommandResponse("shell pm clear", execResult("Success"));
        const result =
          path === "clear"
            ? await new ClearAppData(
                android,
                { create: () => h.adb },
                { cacheInvalidator: invalidator },
              ).execute(appId, 0)
            : await h.makeAction(invalidator).execute("/fake/app.apk", 0);
        expect(result.success).toBe(true);
        await store.put(android.deviceId, stale, generation);
        expect(store.getRecentInMemoryForDevice(android.deviceId)).toEqual(
          fence ? undefined : stale,
        );
        expect(await store.getMostRecent(android.deviceId)).toEqual(fence ? undefined : stale);
      }
    },
  );
});
