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

export const IOS_CAMERA_POSTER_UNSUPPORTED =
  "cameraPoster is unsupported on physical iOS devices: the camera is injected into simulator app processes. Use an iOS Simulator and launchApp to apply the poster.";
export const IOS_CAMERA_POSTER_RELAUNCH_WARNING =
  "The poster applies at the next launchApp (cold launch) of each app. Any app already running must be relaunched; after clear use launchApp coldBoot:true. surface is ignored on iOS.";

export interface IosCameraPosterDependencies {
  registry?: IosCameraPosterRegistry;
  qrWriter?: QrPosterWriter;
  fileExists?: (path: string) => boolean;
  /** Preflighted when a poster is set, so a missing compiler or source fails here, not at launchApp. */
  dylibProvider?: IosCameraPosterDylibProvider;
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
    return { ...base, path, warning: IOS_CAMERA_POSTER_RELAUNCH_WARNING };
  } catch (error) {
    logger.warn(`Failed to record iOS camera poster: ${errorMessage(error)}`, error);
    return { ...base, error: `Failed to record iOS camera poster: ${errorMessage(error)}` };
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
