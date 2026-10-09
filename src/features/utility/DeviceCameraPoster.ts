/**
 * Set or clear a virtual-scene camera poster on a RUNNING Android emulator through
 * the emulator console (`adb -s <serial> emu virtualscene-image <wall|table> [path]`),
 * with no gRPC client and no cold restart (issue #6844).
 *
 * The console answers `OK`/`KO: <reason>` with a zero adb exit code either way, and
 * an OK does not prove the poster is visible: the virtual scene's default camera pose
 * may not face it. The result says so instead of claiming a verified frame.
 */
import { existsSync } from "node:fs";
import { extname, resolve } from "node:path";
import type { BootedDevice } from "../../models";
import type { AdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { consolePortFromSerial } from "../../utils/android-cmdline-tools/EmulatorConsoleClient";
import {
  emulatorConsoleFailureReason,
  emulatorConsoleReportsFailure,
} from "../../utils/android-cmdline-tools/emulatorConsoleReply";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { FileQrPosterWriter, type QrPosterWriter } from "../../utils/qr/QrPosterWriter";

export type CameraPosterSurface = "wall" | "table";

export type SetDeviceCameraPosterInput =
  | { mode: "image"; path: string; surface?: CameraPosterSurface }
  | { mode: "qr"; text: string; surface?: CameraPosterSurface }
  | { mode: "clear"; surface?: CameraPosterSurface };

export interface DeviceCameraPosterState {
  supported: boolean;
  mode?: SetDeviceCameraPosterInput["mode"];
  surface?: CameraPosterSurface;
  /** Host image the console was told to load; absent when clearing. */
  path?: string;
  method?: "android_emulator_console";
  /** Console acceptance is not a camera read-back, so this is never set to true. */
  verified?: boolean;
  warning?: string;
  error?: string;
}

export interface CameraPosterDependencies {
  adbFactory: AdbClientFactory;
  qrWriter?: QrPosterWriter;
  fileExists?: (path: string) => boolean;
}

const POSTER_EXTENSIONS = [".png", ".jpg", ".jpeg"];

export const CAMERA_POSTER_POSE_WARNING =
  "The emulator console accepted the poster but cannot confirm it is visible: the virtual scene's " +
  "default camera pose may not face the poster, so a camera app can still show an empty room. " +
  "Nothing here reads the camera frame back.";

const NOT_VIRTUALSCENE_HINT =
  "The AVD back camera must be 'virtualscene' (hw.camera.back=virtualscene). Cold-boot it with " +
  "startDevice cameraPosterPath or cameraPosterQr, which passes -camera-back virtualscene.";

function unsupported(error: string): DeviceCameraPosterState {
  return { supported: false, error };
}

/** The console splits its command line on whitespace, so such a path cannot be passed. */
function posterPathError(
  path: string,
  fileExists: (path: string) => boolean,
  label: string,
): string | undefined {
  if (!POSTER_EXTENSIONS.includes(extname(path).toLowerCase())) {
    return `${label} must point to a PNG, JPG, or JPEG image.`;
  }
  if (/\s/.test(path)) {
    return `${label} must not contain whitespace because the emulator console splits its command on spaces: ${path}`;
  }
  if (!fileExists(path)) {
    return `Camera poster image does not exist: ${path}`;
  }
  return undefined;
}

async function resolvePosterPath(
  input: Exclude<SetDeviceCameraPosterInput, { mode: "clear" }>,
  deps: CameraPosterDependencies,
): Promise<{ path: string } | { error: string }> {
  const fileExists = deps.fileExists ?? existsSync;
  if (input.mode === "image") {
    const path = resolve(input.path);
    const error = posterPathError(path, fileExists, "cameraPoster.path");
    return error === undefined ? { path } : { error };
  }
  const writer = deps.qrWriter ?? new FileQrPosterWriter();
  const path = await writer.writePoster(input.text);
  const error = posterPathError(path, fileExists, "The generated QR poster path");
  return error === undefined ? { path } : { error };
}

export async function writeDeviceCameraPoster(
  device: BootedDevice,
  input: SetDeviceCameraPosterInput,
  deps: CameraPosterDependencies,
): Promise<DeviceCameraPosterState> {
  if (device.platform !== "android") {
    return unsupported(
      "cameraPoster is unsupported on iOS. Use a running Android emulator booted with a virtual-scene back camera.",
    );
  }
  if (consolePortFromSerial(device.deviceId) === null) {
    return unsupported(
      "cameraPoster is unsupported on physical Android devices: it uses the emulator console. Use an Android emulator.",
    );
  }
  const surface = input.surface ?? "wall";
  const base = { mode: input.mode, surface, method: "android_emulator_console" } as const;
  let path: string | undefined;
  try {
    if (input.mode !== "clear") {
      const resolved = await resolvePosterPath(input, deps);
      if ("error" in resolved) {
        return { supported: true, ...base, error: resolved.error };
      }
      path = resolved.path;
    }
    const command = `emu virtualscene-image ${surface}${path === undefined ? "" : ` ${path}`}`;
    const { stdout, stderr } = await deps.adbFactory.create(device).executeCommand(command);
    if (emulatorConsoleReportsFailure(stdout, stderr)) {
      const reason = emulatorConsoleFailureReason(stdout, stderr);
      return {
        supported: true,
        ...base,
        error: `The emulator console refused '${command}': ${reason}. ${NOT_VIRTUALSCENE_HINT}`,
      };
    }
    return {
      supported: true,
      ...base,
      ...(path === undefined ? {} : { path }),
      warning: CAMERA_POSTER_POSE_WARNING,
    };
  } catch (error) {
    logger.warn(
      `Failed to set camera poster for ${device.deviceId}: ${errorMessage(error)}`,
      error,
    );
    return {
      supported: true,
      ...base,
      error: `Failed to set the emulator camera poster: ${errorMessage(error)}`,
    };
  }
}
