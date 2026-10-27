import { DeviceReadiness } from "../../src/daemon/readiness/DeviceReadiness";
import { parseAppearanceConfig } from "../../src/features/appearance";
import { FakeAdbClientFactory } from "../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../fakes/FakeAdbExecutor";
import { FakeCtrlProxyManager } from "../fakes/FakeCtrlProxyManager";
import { FakeDeviceClientProvider } from "../fakes/FakeDeviceClientProvider";
import { FakeDeviceReadiness } from "../fakes/FakeDeviceReadiness";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";
import { FakeSimctl } from "../fakes/FakeSimctl";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeWindow } from "../fakes/FakeWindow";
import { runDeviceReadinessContract, type ScriptedReadiness } from "./DeviceReadinessContract";

function real(): ScriptedReadiness {
  const adb = new FakeAdbExecutor();
  const simctl = new FakeSimctl();
  const window = new FakeWindow();
  window.configureActiveWindow({ appId: "com.example.app", activityName: "Main", layoutSeqSum: 0 });
  const ctrlProxyManager = new FakeCtrlProxyManager();
  ctrlProxyManager.setInstalled(true);
  ctrlProxyManager.setEnabled(true);
  ctrlProxyManager.setVersionCompatible(true);
  const utils = new FakeDeviceUtils();
  const provider = new FakeDeviceClientProvider(adb, utils, simctl, {
    window,
    ctrlProxyManager,
  });
  const readiness = DeviceReadiness.createInstance(provider, new FakeAdbClientFactory(adb), {
    runnerReadinessTimer: new FakeTimer(),
    appearanceOnConnectDependencies: {
      isSyncEnabled: () => true,
      getConfig: async () => parseAppearanceConfig({ applyOnConnect: false }),
    },
  });
  return {
    readiness,
    connect: (devices) => {
      const androids = devices.filter((device) => device.platform === "android");
      const simulators = devices.filter((device) => device.platform === "ios");
      adb.setDevices(androids);
      simctl.setBootedSimulators(simulators);
      for (const device of simulators) {
        simctl.setDeviceInfo(device.deviceId, {
          udid: device.deviceId,
          name: device.name,
          state: "Booted",
          isAvailable: true,
        });
      }
      simctl.setAvailableSimulators(
        simulators.map((device) => ({
          name: device.name,
          deviceId: device.deviceId,
          platform: "ios",
          isRunning: true,
        })),
      );
      utils.setBootedDevices("android", androids);
      utils.setBootedDevices("ios", simulators);
    },
  };
}

function fake(): ScriptedReadiness {
  const readiness = new FakeDeviceReadiness();
  return { readiness, connect: (devices) => readiness.setConnectedDevices(devices) };
}

runDeviceReadinessContract("DeviceReadiness", real);
runDeviceReadinessContract("FakeDeviceReadiness", fake);
