import { ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS } from "../features/action/installAppTimeout";
import { DISPOSABLE_APP_BULK_UNINSTALL_BUDGET_MS } from "../features/prototype/disposableApp/disposableAppUninstallBudget";

/** Headroom for install inventory, force-stop, user restoration and verification. */
export const INSTALL_APP_MCP_TIMEOUT_HEADROOM_MS = 30_000;

/** Allowance for stamping and signing a disposable prototype APK before it is transferred. */
export const DISPOSABLE_APP_STAMP_MCP_ALLOWANCE_MS = 60_000;

/**
 * Floor for `prototype installApp` (#14184): stamp the APK, then one `adb install -r` transfer,
 * plus the install headroom for reset and permission commands.
 */
export const MIN_PROTOTYPE_INSTALL_APP_MCP_TIMEOUT_MS =
  DISPOSABLE_APP_STAMP_MCP_ALLOWANCE_MS +
  ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS +
  INSTALL_APP_MCP_TIMEOUT_HEADROOM_MS;

/**
 * Floor for `prototype uninstallApp {appId}` (#14184): the disposable installer gives
 * `adb uninstall` the package transfer timeout, plus headroom for the signing inspection and
 * registry update.
 */
export const MIN_PROTOTYPE_UNINSTALL_APP_MCP_TIMEOUT_MS =
  ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS + INSTALL_APP_MCP_TIMEOUT_HEADROOM_MS;

/**
 * Floor for a bulk `prototype uninstallApp` (`all`, `expired`): the manager's own bulk deadline,
 * after which it returns the apps it has not started as `pending`, plus headroom for listing the
 * device's packages and returning that partial result.
 */
export const MIN_PROTOTYPE_BULK_UNINSTALL_APP_MCP_TIMEOUT_MS =
  DISPOSABLE_APP_BULK_UNINSTALL_BUDGET_MS + INSTALL_APP_MCP_TIMEOUT_HEADROOM_MS;

/**
 * The MCP floor of a `prototype installApp` or `uninstallApp` call: one install, one removal by
 * `appId`, or a bulk removal (`all`, `expired`) bounded by the manager's bulk deadline.
 */
export function resolvePrototypeAppBudgetMs(args: Record<string, unknown>): number {
  if (args.action === "installApp") {
    return MIN_PROTOTYPE_INSTALL_APP_MCP_TIMEOUT_MS;
  }
  return typeof args.appId === "string"
    ? MIN_PROTOTYPE_UNINSTALL_APP_MCP_TIMEOUT_MS
    : MIN_PROTOTYPE_BULK_UNINSTALL_APP_MCP_TIMEOUT_MS;
}
