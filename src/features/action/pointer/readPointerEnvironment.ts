import type { BootedDevice } from "../../../models";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { readAndroidDeviceApiLevel } from "../../../utils/android-cmdline-tools/readAndroidDeviceApiLevel";
import { errorMessage } from "../../../utils/describeUnknownError";
import { logger } from "../../../utils/logger";
import { AndroidCtrlProxyClient } from "../../observe/android";
import {
  HOVER_INPUT_CAPABILITY,
  STYLUS_INPUT_CAPABILITY,
} from "../../observe/android/ctrlProxyProtocol/capabilities";
import type { PointerEnvironment } from "./PointerInjector";
import { pointerCapabilities } from "./selectPointerRoute";

const API_READ_TIMEOUT_MS = 5000;
const ROOT_READ_TIMEOUT_MS = 5000;

/**
 * Whether `adb shell` runs as root, as after `adb root` on an emulator or userdebug build. The uinput
 * route needs it to open `/dev/uinput`. AutoMobile never runs `adb root` itself: it restarts adbd.
 */
export async function readRootShell(adb: AdbExecutor, signal?: AbortSignal): Promise<boolean> {
  try {
    const { stdout } = await adb.executeCommand("shell id -u", {
      timeoutMs: ROOT_READ_TIMEOUT_MS,
      noRetry: true,
      signal,
    });
    return stdout.trim() === "0";
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    logger.warn(`[pointer] could not read the adb shell uid: ${errorMessage(error)}`, error);
    return false;
  }
}

/**
 * The device facts the pointer routes decide on: the Android API level and the pointer capability
 * flags of an established CtrlProxy connection. Best effort: a runner that cannot be asked advertises
 * nothing, which refuses the request instead of guessing.
 */
export async function readPointerEnvironment(
  device: BootedDevice,
  adb: AdbExecutor,
  signal?: AbortSignal,
): Promise<PointerEnvironment> {
  // An established runner connection only: with none, no capability is advertised.
  const client = AndroidCtrlProxyClient.getExistingInstance(device.deviceId);
  const advertised = new Set<string>();
  try {
    for (const capability of [HOVER_INPUT_CAPABILITY, STYLUS_INPUT_CAPABILITY]) {
      if (client && (await client.supportsCommand(capability))) {
        advertised.add(capability);
      }
    }
  } catch (error) {
    if (signal?.aborted) {
      throw error;
    }
    logger.warn(
      `[pointer] could not read the runner's capabilities: ${errorMessage(error)}`,
      error,
    );
  }
  const apiLevel = await readAndroidDeviceApiLevel(
    adb,
    API_READ_TIMEOUT_MS,
    undefined,
    signal,
  ).catch((error: unknown) => {
    if (signal?.aborted) {
      throw error;
    }
    logger.warn(`[pointer] could not read the Android API level: ${errorMessage(error)}`, error);
    return null;
  });
  return {
    platform: "android",
    apiLevel: apiLevel ?? undefined,
    capabilities: pointerCapabilities((name) => advertised.has(name)),
    rootShell: await readRootShell(adb, signal),
  };
}
