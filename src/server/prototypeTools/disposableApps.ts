import type { z } from "zod/v4";
import { defaultDisposableAppManager } from "../../features/prototype/disposableApp/defaultDisposableAppManager";
export { defaultDisposableAppManager };
import {
  DisposableAppManager,
  type DisposableAppInstallInput,
  type DisposableAppUninstallTarget,
} from "../../features/prototype/disposableApp/DisposableAppManager";
import type { DisposableAppPlatform } from "../../features/prototype/disposableApp/disposableAppId";
import { isAndroidStampAssetId } from "../../features/prototype/disposableApp/android/AndroidStampZip";
import { preparePrototypeAssets } from "../../features/prototype/prototypeAssetUploader";
import { requireDisposableAppSimulator } from "../../features/prototype/disposableApp/ios/iosDisposableAppIdentity";
import type { PrototypeJson } from "../../features/prototype/prototypeJson";
import type { BootedDevice } from "../../models";
import { ActionableError, toActionableError } from "../../models/ActionableError";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import type { prototypeSchema } from "./schemas";
import type { AssetReaders, PrototypeOutput } from "./types";

/**
 * The prototype tool's disposable-app actions (#14184): install a spec as its own app, list the
 * apps this host installed, and uninstall or expire them, on the injected `DisposableAppManager`.
 */
export type PrototypeDisposableAppAction = "installApp" | "listApps" | "uninstallApp";

export const isDisposableAppAction = (action: string): action is PrototypeDisposableAppAction =>
  action === "installApp" || action === "listApps" || action === "uninstallApp";

/** The manager calls these actions make; tests inject a manager over fakes. */
export type PrototypeDisposableApps = Pick<DisposableAppManager, "install" | "list" | "uninstall">;

/**
 * The injected manager, or the daemon's built on the first disposable-app call, so other actions
 * never construct the disposable app stampers.
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
      `Disposable prototype apps need an Android device or iOS simulator; ${device.deviceId} is ${device.platform}.`,
    );
  }
  if (device.platform === "ios") {
    requireDisposableAppSimulator(device.deviceId);
  }
  return device.platform;
}

async function installInput(
  device: BootedDevice,
  args: PrototypeArgs,
  readers: AssetReaders,
): Promise<DisposableAppInstallInput> {
  const platform = appPlatform(device);
  if (platform === "android") {
    const invalid = (args.assets ?? []).find(({ id }) => !isAndroidStampAssetId(id));
    if (invalid) {
      throw new ActionableError(
        `Android disposable app asset id '${invalid.id}' must be letters, digits, '_' or '-', optionally in dot-separated parts. Rename it in assets and in the spec, then retry.`,
      );
    }
  }
  const prepared = await preparePrototypeAssets(
    args.assets ?? [],
    readers.assetFileReader,
    readers.observationScreenshotReader,
    readers.env,
  );
  if ("error" in prepared) {
    throw new ActionableError(prepared.error);
  }
  // The schema requires app and a spec (inline or read from specPath) before dispatch.
  return {
    deviceId: device.deviceId,
    platform,
    spec: args.spec as PrototypeJson,
    app: args.app!,
    assets: prepared.assets,
  };
}

interface DisposableAppRouteContext {
  readers: AssetReaders;
  attachments?: { forget(deviceId: string, appId: string): Promise<void> };
}

async function run(
  apps: PrototypeDisposableApps,
  device: BootedDevice,
  args: PrototypeArgs,
  { readers, attachments }: DisposableAppRouteContext,
): Promise<PrototypeOutput> {
  if (args.action === "installApp") {
    const disposableApp = await apps.install(await installInput(device, args, readers));
    await attachments?.forget(device.deviceId, disposableApp.appId);
    return { success: true, disposableApp };
  }
  if (args.action === "listApps") {
    return { success: true, disposableApps: await apps.list(device.deviceId, appPlatform(device)) };
  }
  const target = uninstallTarget(args);
  const uninstalled = await apps.uninstall(device.deviceId, appPlatform(device), target);
  await Promise.all(
    uninstalled.removed.map(({ appId }) => attachments?.forget(device.deviceId, appId)),
  );
  return { success: true, uninstalled };
}

/** Runs one disposable-app action; a refusal or device failure becomes a failed result. */
export async function disposableAppOutput(
  apps: PrototypeDisposableApps,
  device: BootedDevice,
  args: PrototypeArgs,
  context: DisposableAppRouteContext,
): Promise<PrototypeOutput> {
  try {
    return await run(apps, device, args, context);
  } catch (error) {
    logger.warn(`prototype ${args.action} failed on ${device.deviceId}`, error);
    return {
      success: false,
      error: toActionableError(error, `prototype ${args.action} failed`).message,
    };
  }
}
