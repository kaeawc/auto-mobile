import { ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS } from "../../action/installAppTimeout";

/**
 * Worst case for removing one disposable app (#14184): the `adb uninstall` deadline plus an
 * allowance for the signing inspection and the registry update around it.
 */
export const DISPOSABLE_APP_UNINSTALL_STEP_MS = ANDROID_PACKAGE_TRANSFER_TIMEOUT_MS + 15_000;

/** Worst-case removals one bulk `uninstallApp` (`all`, `expired`) call may start. */
export const DISPOSABLE_APP_BULK_UNINSTALL_WORST_CASE_APPS = 3;

/**
 * Deadline of one bulk `uninstallApp` call. The manager starts another app only while a whole
 * worst-case step still fits, and returns the rest as `pending`, so the call ends inside the MCP
 * request budget however many apps the device holds.
 */
export const DISPOSABLE_APP_BULK_UNINSTALL_BUDGET_MS =
  DISPOSABLE_APP_BULK_UNINSTALL_WORST_CASE_APPS * DISPOSABLE_APP_UNINSTALL_STEP_MS;
