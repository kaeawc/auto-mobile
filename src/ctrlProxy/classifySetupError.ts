import type { ProxySetupErrorCategory } from "../utils/interfaces/ProxyManager";
import { isAdbMissingDeviceError } from "../utils/android-cmdline-tools/AdbDeviceHealth";

export function classifySetupError(
  errorMsg: string,
  deviceId?: string,
): {
  message: string;
  category: ProxySetupErrorCategory;
} {
  const errorLower = errorMsg.toLowerCase();
  // Serial-qualified ADB wording (`error: device 'emulator-5556' not found`,
  // #13392) never contains the unqualified "device not found" substring, so
  // defer to the shared ADB classifier. A serial naming a different device
  // is not this device's connection loss and stays unclassified.
  const missingDevice = isAdbMissingDeviceError(errorMsg, deviceId);

  // Provide categorized error messages for better debugging, and carry the
  // same category as a typed field (issue #7541) so retry-decision code
  // downstream (ToolExecutionContext.ensureAccessibilityServiceReady)
  // doesn't have to re-derive it from unanchored substrings a second time.
  let message = "Failed to setup Accessibility Service";
  let category: ProxySetupErrorCategory = "unknown";
  if (errorLower.includes("permission denied") || errorLower.includes("not permitted")) {
    message = "Failed to setup Accessibility Service due to permission error";
    category = "permission";
  } else if (
    missingDevice ||
    errorLower.includes("device not found") ||
    errorLower.includes("no devices") ||
    errorLower.includes("offline")
  ) {
    message = "Failed to setup Accessibility Service due to device connection issue";
    category = "deviceConnection";
  } else if (errorLower.includes("timeout") || errorLower.includes("timed out")) {
    message = "Failed to setup Accessibility Service due to timeout";
    category = "timeout";
  } else if (/download|network|unreachable/.test(errorLower)) {
    message = "Failed to setup Accessibility Service due to network/download error";
    category = "networkDownload";
  } else if (errorLower.includes("not supported")) {
    message =
      "Failed to setup Accessibility Service - settings toggle not supported on this device";
    category = "unsupported";
  } else if (/installation failed|install/.test(errorLower)) {
    message = "Failed to setup Accessibility Service due to APK installation error";
    category = "install";
  }

  return { message, category };
}
