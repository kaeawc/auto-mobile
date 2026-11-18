import type { z } from "zod/v4";
import {
  DisposableAppManager,
  type DisposableAppInstallInput,
  type DisposableAppUninstallTarget,
} from "../../features/prototype/disposableApp/DisposableAppManager";
import type { DisposableAppPlatform } from "../../features/prototype/disposableApp/disposableAppId";
import { FileDisposableAppRegistry } from "../../features/prototype/disposableApp/DisposableAppRegistry";
import { NodeDisposableAppRegistryStore } from "../../features/prototype/disposableApp/NodeDisposableAppRegistryStore";
import {
  AndroidDisposableAppInstaller,
  androidDisposableAppDevices,
} from "../../features/prototype/disposableApp/android/AndroidDisposableAppInstaller";
import { AndroidDisposableAppStamper } from "../../features/prototype/disposableApp/android/AndroidDisposableAppStamper";
import type { PrototypeJson } from "../../features/prototype/prototypeJson";
import type { BootedDevice } from "../../models";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../utils/logger";
import { defaultTimer, type Timer } from "../../utils/SystemTimer";
import type { prototypeSchema } from "./schemas";
import type { PrototypeOutput } from "./types";

/**
 * The prototype tool's disposable-app actions (#14184): install a spec as its own app, list the
 * apps this host installed, and uninstall or expire them, on the injected `DisposableAppManager`.
 */
export type PrototypeDisposableAppAction = "installApp" | "listApps" | "uninstallApp";

export const isDisposableAppAction = (action: string): action is PrototypeDisposableAppAction =>
  action === "installApp" || action === "listApps" || action === "uninstallApp";

/** The manager calls these actions make; tests inject a manager over fakes. */
export type PrototypeDisposableApps = Pick<DisposableAppManager, "install" | "list" | "uninstall">;

/** The daemon's manager: Android stamping and adb, with the registry under the data dir. */
export function defaultDisposableAppManager(
  dependencies: { adbFactory?: AdbClientFactory; timer?: Pick<Timer, "now"> } = {},
): DisposableAppManager {
  return new DisposableAppManager({
    platforms: {
      android: {
        stamper: new AndroidDisposableAppStamper(),
        installer: new AndroidDisposableAppInstaller(
          androidDisposableAppDevices(dependencies.adbFactory),
        ),
      },
    },
    registry: new FileDisposableAppRegistry(new NodeDisposableAppRegistryStore()),
    timer: dependencies.timer ?? defaultTimer,
  });
}

/**
 * The injected manager, or the daemon's built on the first disposable-app call, so other actions
 * never construct the Android stamper.
 */
export function lazyDisposableApps(
  dependencies: { disposableApps?: PrototypeDisposableApps; adbFactory?: AdbClientFactory },
  timer: Pick<Timer, "now">,
): () => PrototypeDisposableApps {
  let apps = dependencies.disposableApps;
  return () =>
    (apps ??= defaultDisposableAppManager({ adbFactory: dependencies.adbFactory, timer }));
}

type PrototypeArgs = z.infer<typeof prototypeSchema>;

function uninstallTarget(args: PrototypeArgs): DisposableAppUninstallTarget {
  if (args.appId !== undefined) {
    return { appId: args.appId };
  }
  return args.all === true ? { all: true } : { expired: true };
}

function appPlatform(device: BootedDevice): DisposableAppPlatform {
  if (device.platform !== "android" && device.platform !== "ios") {
    throw new ActionableError(
      `Disposable prototype apps need an Android device; ${device.deviceId} is ${device.platform}.`,
    );
  }
  return device.platform;
}

function installInput(device: BootedDevice, args: PrototypeArgs): DisposableAppInstallInput {
  // The schema requires app and a spec (inline or read from specPath) before dispatch.
  return {
    deviceId: device.deviceId,
    platform: appPlatform(device),
    spec: args.spec as PrototypeJson,
    app: args.app!,
  };
}

async function run(
  apps: PrototypeDisposableApps,
  device: BootedDevice,
  args: PrototypeArgs,
): Promise<PrototypeOutput> {
  if (args.action === "installApp") {
    return { success: true, disposableApp: await apps.install(installInput(device, args)) };
  }
  if (args.action === "listApps") {
    return { success: true, disposableApps: await apps.list(device.deviceId, appPlatform(device)) };
  }
  const target = uninstallTarget(args);
  const uninstalled = await apps.uninstall(device.deviceId, appPlatform(device), target);
  return { success: true, uninstalled };
}

/** Runs one disposable-app action; a refusal or device failure becomes a failed result. */
export async function disposableAppOutput(
  apps: PrototypeDisposableApps,
  device: BootedDevice,
  args: PrototypeArgs,
): Promise<PrototypeOutput> {
  try {
    return await run(apps, device, args);
  } catch (error) {
    logger.warn(`prototype ${args.action} failed on ${device.deviceId}`, error);
    return {
      success: false,
      error: toActionableError(error, `prototype ${args.action} failed`).message,
    };
  }
}
