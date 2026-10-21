import { describe, expect, test } from "bun:test";
import { IOSCtrlProxyManager } from "../../src/ctrlProxy/IOSCtrlProxyManager";
import { DeviceAppManager } from "../../src/utils/ios-cmdline-tools/DeviceAppManager";
import type { BootedDevice } from "../../src/models";
import { createExecResult } from "../../src/utils/execResult";
import type { IosPhysicalDeviceLister } from "../../src/utils/ios-cmdline-tools/DevicectlDeviceLister";
import type { Xcodebuild } from "../../src/utils/ios-cmdline-tools/XcodebuildClient";
import { XcodeSigningManager } from "../../src/utils/ios-cmdline-tools/XcodeSigning";
import { FakeChildProcess } from "../fakes/FakeChildProcess";
import { FakeIosTunnelClient } from "../fakes/FakeIosTunnelClient";
import { FakeProcessExecutor } from "../fakes/FakeProcessExecutor";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  createFakeBuilder,
  createManagerWithOwnSteps,
  installIosManagerSuiteHooks,
} from "../helpers/iosCtrlProxyManagerHarness";

const LEGACY_APP_BUNDLE_ID = "dev.jasonpearson.automobile.XCTestServiceApp";
const SKIP_ENV = "AUTOMOBILE_IOS_SKIP_CTRL_PROXY_APP_HASH";
const SIMULATOR: BootedDevice = {
  deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
  platform: "ios",
  name: "iPhone Simulator",
};
const PHYSICAL: BootedDevice = { deviceId: "00008030001E28C11E", platform: "ios", name: "iPhone" };

class NoSigningManager extends XcodeSigningManager {
  override async resolveSigningForDevice(): ReturnType<
    XcodeSigningManager["resolveSigningForDevice"]
  > {
    return { style: "automatic", buildSettings: [], allowProvisioningUpdates: false, warnings: [] };
  }
}

interface AppLookup {
  deviceId: string;
  bundleId: string;
  simulator: boolean | undefined;
}

function recordingAppManager(lookups: AppLookup[], hash: string | null) {
  return new (class extends DeviceAppManager {
    override async getInstalledAppBundleHash(
      deviceId: string,
      bundleId: string,
      simulator?: boolean,
    ) {
      lookups.push({ deviceId, bundleId, simulator });
      return hash;
    }
    override async uninstallApp() {}
  })();
}

/** Runs `fn` with the skip variable set (or unset when `value` is undefined), then restores it. */
async function withSkipEnv(value: string | undefined, fn: () => Promise<void>): Promise<void> {
  const previous = process.env[SKIP_ENV];
  if (value === undefined) {
    delete process.env[SKIP_ENV];
  } else {
    process.env[SKIP_ENV] = value;
  }
  try {
    await fn();
  } finally {
    if (previous === undefined) {
      delete process.env[SKIP_ENV];
    } else {
      process.env[SKIP_ENV] = previous;
    }
  }
}

describe("IOSCtrlProxyManager collaborator wiring", () => {
  let fakeTimer: FakeTimer;
  installIosManagerSuiteHooks((ctx) => {
    fakeTimer = ctx.fakeTimer;
  });

  describe("legacy app lookup", () => {
    test.each([
      ["simulator", SIMULATOR, true],
      ["physical device", PHYSICAL, false],
    ] as const)("uses the legacy bundle id and the %s flag", async (_kind, device, simulator) => {
      const lookups: AppLookup[] = [];
      const { steps } = createManagerWithOwnSteps({
        device,
        timer: fakeTimer,
        processExecutor: new FakeProcessExecutor(),
        deviceAppManager: recordingAppManager(lookups, null),
      });

      await steps.uninstallLegacyAppIfPresent();

      expect(lookups).toEqual([
        { deviceId: device.deviceId, bundleId: LEGACY_APP_BUNDLE_ID, simulator },
      ]);
    });
  });

  describe("installed app hash check on device launch", () => {
    async function launchOnDevice(lookups: AppLookup[]): Promise<void> {
      const builder = createFakeBuilder();
      builder.getXctestrunPath = async () => "/tmp/device.xctestrun";
      builder.getExpectedAppHash = () => "same-hash";
      const xcodebuild: Xcodebuild = {
        executeCommand: async () => createExecResult("", ""),
        isAvailable: async () => true,
        startStreaming: async () => {
          // The executor hands back the primed fake typed as the host child process.
          const spawner = new FakeProcessExecutor();
          spawner.setNextSpawnProcess(new FakeChildProcess(fakeTimer));
          return spawner.spawn("xcodebuild", []);
        },
      };
      const { steps } = createManagerWithOwnSteps({
        device: PHYSICAL,
        timer: fakeTimer,
        builder,
        processExecutor: new FakeProcessExecutor(),
        deviceAppManager: recordingAppManager(lookups, "same-hash"),
        signingManager: new NoSigningManager(),
        xcodebuild,
        tunnelClient: new FakeIosTunnelClient(),
      });
      await steps.startOnDevice();
    }

    test("looks the installed app up by the CtrlProxy bundle id for the device", async () => {
      const lookups: AppLookup[] = [];
      await withSkipEnv(undefined, () => launchOnDevice(lookups));
      expect(lookups).toEqual([
        {
          deviceId: PHYSICAL.deviceId,
          bundleId: IOSCtrlProxyManager.APP_BUNDLE_ID,
          simulator: false,
        },
      ]);
    });

    test.each(["1", "true"])("skips verification when the variable is %s", async (value) => {
      const lookups: AppLookup[] = [];
      await withSkipEnv(value, () => launchOnDevice(lookups));
      expect(lookups).toEqual([]);
    });

    test("does not skip verification for other values", async () => {
      const lookups: AppLookup[] = [];
      await withSkipEnv("0", () => launchOnDevice(lookups));
      expect(lookups).toHaveLength(1);
    });
  });

  describe("physical device detection", () => {
    function managerWithLister(lister: IosPhysicalDeviceLister): IOSCtrlProxyManager {
      return IOSCtrlProxyManager.createForTestingWithOptions({
        device: PHYSICAL,
        timer: fakeTimer,
        processExecutor: new FakeProcessExecutor(),
        physicalDeviceLister: lister,
      });
    }

    test("consults the injected devicectl lister", async () => {
      const absent = managerWithLister({
        listConnectedDevices: async () => ({ devices: [], complete: true }),
      });
      const present = managerWithLister({
        listConnectedDevices: async () => ({ devices: [PHYSICAL], complete: true }),
      });
      // Detection is owned by a private collaborator; this is the one reach into the wiring.
      expect(await absent.diagnostics.deviceDetector.isDeviceDetected()).toBe(false);
      expect(await present.diagnostics.deviceDetector.isDeviceDetected()).toBe(true);
    });
  });

  describe("step overrides", () => {
    test("an undefined override keeps the manager's own step", async () => {
      const lookups: AppLookup[] = [];
      const manager = IOSCtrlProxyManager.createForTestingWithOptions({
        device: SIMULATOR,
        timer: fakeTimer,
        builder: createFakeBuilder(),
        processExecutor: new FakeProcessExecutor(),
        deviceAppManager: recordingAppManager(lookups, null),
        steps: { uninstallLegacyAppIfPresent: undefined },
      });
      fakeTimer.enableAutoAdvance();

      // Setup fails further on with the fakes; only the legacy probe matters here.
      await manager.setup().catch(() => undefined);

      expect(lookups[0]?.bundleId).toBe(LEGACY_APP_BUNDLE_ID);
    });
  });
});
