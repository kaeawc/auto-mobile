import { ActionableError } from "../models/ActionableError";
import {
  isAdbDeviceAuthorizingError,
  isAdbDeviceOfflineError,
  isAdbPostDispatchTransportError,
} from "../utils/android-cmdline-tools/AdbDeviceHealth";

// Install failures that an in-place `install -r -d` cannot fix but a fresh uninstall + reinstall can.
// VERSION_DOWNGRADE: `-d` only permits downgrades of debuggable apps/builds, so a user-build device
// with a newer non-debuggable CtrlProxy than the pinned APK needs the uninstall. INSTALL_FAILED_DEXOPT
// and INSTALL_FAILED_INVALID_APK are deliberately excluded: an invalid APK fails identically on a
// fresh install, and dexopt failures are storage/runtime faults a wipe rarely clears while it does
// discard the user's accessibility enablement; both stay installed and surface the failure.
export const SIGNATURE_MISMATCH_FAILURE_CODES = new Set([
  "INSTALL_FAILED_UPDATE_INCOMPATIBLE",
  "INSTALL_FAILED_VERSION_DOWNGRADE",
  "INSTALL_PARSE_FAILED_INCONSISTENT_CERTIFICATES",
  "INSTALL_FAILED_SHARED_USER_INCOMPATIBLE",
]);

/** Extracts the `INSTALL_*` failure token from `adb install` output, if present. */
export function extractInstallFailureCode(message: string): string | undefined {
  const anchored = /Failure \[(INSTALL_[A-Z_]+)/.exec(message)?.[1];
  return anchored ?? /INSTALL_[A-Z_]+/.exec(message)?.[0];
}

/** An adb install failure that is safe to retry before reporting readiness failure. */
export class RetryableCtrlProxyInstallFailure extends ActionableError {}

const TRANSIENT_INSTALL_FAILURE_CODES = new Set([
  "INSTALL_FAILED_INTERNAL_ERROR",
  "INSTALL_FAILED_NOT_READY",
]);

export function isTransientInstallFailureCode(code: string | undefined): boolean {
  return (
    code === undefined ||
    (!SIGNATURE_MISMATCH_FAILURE_CODES.has(code) && TRANSIENT_INSTALL_FAILURE_CODES.has(code))
  );
}

/** Only the header-only streamed-install failure is newly retryable outside automotive/watch. */
export function isEmptyStreamedInstallFailure(
  stdout: string,
  stderr: string,
  message: string,
  deviceId: string,
): boolean {
  const diagnostics = `${stdout}\n${stderr}\n${message}`;
  return (
    stdout.trim() === "Performing Streamed Install" &&
    /^adb: failed to install [^\r\n]+\.apk:\s*$/i.test(stderr.trim()) &&
    extractInstallFailureCode(diagnostics) === undefined &&
    !/Failure\s*\[/i.test(diagnostics) &&
    !isAdbDeviceAuthorizingError(diagnostics) &&
    !isAdbDeviceOfflineError(diagnostics) &&
    !diagnostics.split(/\r?\n/).some((line) => {
      // CommandError can prefix the raw adb message with its excerpt label.
      const diagnostic = line.slice(Math.max(0, line.toLowerCase().indexOf("adb:")));
      return isAdbPostDispatchTransportError(diagnostic, undefined, deviceId, { stdout });
    })
  );
}
