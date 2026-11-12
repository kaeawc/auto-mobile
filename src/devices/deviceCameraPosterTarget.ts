import { ActionableError } from "../models/ActionableError";
import { resolveIosDeviceKind } from "../utils/ios-cmdline-tools/IosDeviceKind";
import { isAndroidEmulatorSerial } from "../utils/androidSerial";

interface CameraPosterTarget {
  platform: string;
  deviceId?: string;
}

export function validateCameraPosterRequest(
  request: CameraPosterTarget,
  cameraPosterPath: string | undefined,
): void {
  if (cameraPosterPath === undefined) {
    return;
  }
  if (request.platform !== "android" && request.platform !== "ios") {
    throw new ActionableError("cameraPosterPath requires an Android emulator or an iOS Simulator.");
  }
  if (
    request.platform === "ios" &&
    request.deviceId &&
    resolveIosDeviceKind({ deviceId: request.deviceId }) !== "simulator"
  ) {
    throw new ActionableError(
      "cameraPoster is unsupported on physical iOS devices: the camera is injected into simulator app processes. Use an iOS Simulator.",
    );
  }
}

export function validateCameraPosterTarget(
  device: CameraPosterTarget,
  cameraPosterPath: string | undefined,
): void {
  validateCameraPosterRequest(device, cameraPosterPath);
  if (
    cameraPosterPath !== undefined &&
    device.platform === "android" &&
    device.deviceId &&
    !isAndroidEmulatorSerial(device.deviceId)
  ) {
    throw new ActionableError(
      "cameraPosterPath is unsupported on physical Android devices. Use a stopped Android emulator.",
    );
  }
}

export function validateRunningCameraPosterTarget(
  device: CameraPosterTarget,
  cameraPosterPath: string | undefined,
): void {
  if (cameraPosterPath !== undefined && device.platform === "android") {
    throw new ActionableError(
      "cameraPosterPath is unsupported on a running Android emulator. Stop it first.",
    );
  }
}
