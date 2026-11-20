import type { AdbClientFactory } from "../../../utils/android-cmdline-tools/AdbClientFactory";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import { DisposableAppManager, type DisposableAppPlatformSupport } from "./DisposableAppManager";
import { FileDisposableAppRegistry } from "./DisposableAppRegistry";
import { NodeDisposableAppRegistryStore } from "./NodeDisposableAppRegistryStore";
import {
  AndroidDisposableAppInstaller,
  androidDisposableAppDevices,
} from "./android/AndroidDisposableAppInstaller";
import { AndroidDisposableAppStamper } from "./android/AndroidDisposableAppStamper";
import { createIosDisposableAppSupport } from "./ios/iosDisposableAppFactory";

// Share the live managers so acquisition expiry uses the same app locks as prototype actions.
const nativeManagers = new WeakMap<Pick<Timer, "now">, DisposableAppManager>();
const nativeRegistry = new FileDisposableAppRegistry(new NodeDisposableAppRegistryStore());

/** The daemon's manager: Android and iOS support, with the registry under the data dir. */
export function defaultDisposableAppManager(
  dependencies: { adbFactory?: AdbClientFactory; timer?: Pick<Timer, "now"> } = {},
): DisposableAppManager {
  const timer = dependencies.timer ?? defaultTimer;
  if (!dependencies.adbFactory) {
    const existing = nativeManagers.get(timer);
    if (existing) {
      return existing;
    }
  }
  let stamper: AndroidDisposableAppStamper | undefined;
  let ios: DisposableAppPlatformSupport | undefined;
  const manager = new DisposableAppManager({
    platforms: {
      get ios() {
        return (ios ??= createIosDisposableAppSupport());
      },
      android: {
        get stamper() {
          return (stamper ??= new AndroidDisposableAppStamper());
        },
        installer: new AndroidDisposableAppInstaller(
          androidDisposableAppDevices(dependencies.adbFactory),
        ),
      },
    },
    registry: nativeRegistry,
    timer,
  });
  if (!dependencies.adbFactory) {
    nativeManagers.set(timer, manager);
  }
  return manager;
}
