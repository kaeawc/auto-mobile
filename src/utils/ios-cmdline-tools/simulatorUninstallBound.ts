import { ActionableError } from "../../models/ActionableError";

/** `simctl uninstall` is a local filesystem removal; bound it well under the 60-second command budget. */
export const SIMULATOR_UNINSTALL_TIMEOUT_MS = 30_000;

/**
 * The error for an uninstall that was dispatched and never acknowledged: the app may or may not be
 * gone, so it is neither a success nor a plain failure (issue #10077). Shared by every
 * `simctl uninstall` caller so the disclosure reads the same on each path.
 */
export function indeterminateSimulatorUninstallError(
  bundleId: string,
  cause: unknown,
): ActionableError {
  return new ActionableError(
    `Uninstall outcome is indeterminate: xcrun simctl uninstall was dispatched but did not finish within ` +
      `${SIMULATOR_UNINSTALL_TIMEOUT_MS} ms, so ${bundleId} may or may not be uninstalled. ` +
      "Do not retry automatically. List the installed apps to check before retrying.",
    { cause },
  );
}
