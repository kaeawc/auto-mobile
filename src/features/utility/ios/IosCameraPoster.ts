import { existsSync } from "node:fs";
import { extname } from "node:path";
import type { BootedDevice } from "../../../models";
import { resolveIosDeviceKind } from "../../../utils/ios-cmdline-tools/IosDeviceKind";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../../utils/workingDirectory";
import { FileQrPosterWriter, type QrPosterWriter } from "../../../utils/qr/QrPosterWriter";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import type { DeviceCameraPosterState, SetDeviceCameraPosterInput } from "../DeviceCameraPoster";
import { iosCameraPosterRegistry, type IosCameraPosterRegistry } from "./IosCameraPosterRegistry";
import {
  iosCameraPosterDylibProvider,
  type IosCameraPosterDylibProvider,
} from "./IosCameraPosterDylibProvider";
import {
  defaultIosCameraPosterDeviceWide,
  type IosCameraPosterDeviceWide,
} from "./IosCameraPosterDeviceWide";

export const IOS_CAMERA_POSTER_UNSUPPORTED =
  "cameraPoster is unsupported on physical iOS devices: the camera is injected into simulator app processes. Use an iOS Simulator and launchApp to apply the poster.";
export const IOS_CAMERA_POSTER_RELAUNCH_WARNING =
  "The poster applies at the next launch of each app, from launchApp, the home screen or XCUITest. Any app already running must be relaunched; after clear use launchApp coldBoot:true. surface is ignored on iOS.";
export const IOS_CAMERA_POSTER_LAUNCH_ONLY_WARNING =
  "The poster applies only at the next launchApp (cold launch) of each app: it could not be turned on for apps launched another way.";

export interface IosCameraPosterDependencies {
  registry?: IosCameraPosterRegistry;
  qrWriter?: QrPosterWriter;
  fileExists?: (path: string) => boolean;
  /** Preflighted when a poster is set, so a missing compiler or source fails here, not at launchApp. */
  dylibProvider?: IosCameraPosterDylibProvider;
  /** Turns the poster on for apps launched any way, not only by launchApp (#19047). */
  deviceWide?: Pick<IosCameraPosterDeviceWide, "activate" | "deactivate">;
}

export async function writeIosCameraPoster(
  device: BootedDevice,
  input: SetDeviceCameraPosterInput,
  deps: IosCameraPosterDependencies = {},
): Promise<DeviceCameraPosterState> {
  if (resolveIosDeviceKind(device) !== "simulator") {
    return { supported: false, error: IOS_CAMERA_POSTER_UNSUPPORTED };
  }
  const base = {
    supported: true,
    mode: input.mode,
    surface: input.surface,
    method: "ios_simulator_dyld_injection",
    relaunchRequired: true,
  } as const;
  const registry = deps.registry ?? iosCameraPosterRegistry;
  try {
    if (input.mode === "clear") {
      registry.clear(device.deviceId);
      // Awaited so the launchd environment is back to its pre-poster state when clear returns.
      await deviceWideActivator(deps)?.deactivate(device.deviceId);
      return { ...base, warning: IOS_CAMERA_POSTER_RELAUNCH_WARNING };
    }
    const recordable = await recordablePosterPath(input, deps);
    if ("error" in recordable) {
      return { ...base, error: recordable.error };
    }
    const { path } = recordable;
    registry.set(
      device.deviceId,
      input.mode === "image" ? { kind: "image", path } : { kind: "qr", text: input.text, path },
    );
    const failure = await activateDeviceWide(device.deviceId, deviceWideActivator(deps));
    return {
      ...base,
      path,
      deviceWide: failure === undefined,
      warning:
        failure === undefined
          ? IOS_CAMERA_POSTER_RELAUNCH_WARNING
          : [IOS_CAMERA_POSTER_LAUNCH_ONLY_WARNING, failure].filter(Boolean).join(" "),
    };
  } catch (error) {
    logger.warn(`Failed to record iOS camera poster: ${errorMessage(error)}`, error);
    return { ...base, error: `Failed to record iOS camera poster: ${errorMessage(error)}` };
  }
}

/**
 * The production activator pairs with the production dylib provider; a caller that injects its own
 * provider (a test fake) gets device-wide activation only by injecting an activator too.
 */
function deviceWideActivator(
  deps: IosCameraPosterDependencies,
): Pick<IosCameraPosterDeviceWide, "activate" | "deactivate"> | undefined {
  return deps.deviceWide ?? (deps.dylibProvider ? undefined : defaultIosCameraPosterDeviceWide());
}

/**
 * Per-launch injection still applies when this fails, so the poster stays recorded. Returns why
 * it failed, or undefined once the poster is on device-wide.
 */
async function activateDeviceWide(
  udid: string,
  deviceWide: Pick<IosCameraPosterDeviceWide, "activate"> | undefined,
): Promise<string | undefined> {
  if (!deviceWide) {
    return "";
  }
  try {
    await deviceWide.activate(udid);
    return undefined;
  } catch (error) {
    logger.warn(`Device-wide iOS camera poster failed on ${udid}: ${errorMessage(error)}`, error);
    return errorMessage(error);
  }
}

/** The poster is not recorded when its library cannot be prepared; the caller sees why. */
async function preflightDylib(provider: IosCameraPosterDylibProvider): Promise<string | undefined> {
  try {
    await provider.ensure();
    return undefined;
  } catch (error) {
    logger.warn(`iOS camera poster dylib preflight failed: ${errorMessage(error)}`, error);
    return `Camera poster not recorded: ${errorMessage(error)}`;
  }
}

/** A validated host image (QR rendered first) whose injection library is ready. */
async function recordablePosterPath(
  input: Exclude<SetDeviceCameraPosterInput, { mode: "clear" }>,
  deps: IosCameraPosterDependencies,
): Promise<{ path: string } | { error: string }> {
  const path = resolvePathFromDaemonLaunchWorkingDirectory(
    input.mode === "image"
      ? input.path
      : await (deps.qrWriter ?? new FileQrPosterWriter()).writePoster(input.text),
  );
  if (![".png", ".jpg", ".jpeg"].includes(extname(path).toLowerCase())) {
    return { error: "cameraPoster.path must point to a PNG, JPG, or JPEG image." };
  }
  if (!(deps.fileExists ?? existsSync)(path)) {
    return { error: `Camera poster image does not exist: ${path}` };
  }
  const preflight = await preflightDylib(deps.dylibProvider ?? iosCameraPosterDylibProvider);
  return preflight === undefined ? { path } : { error: preflight };
}
