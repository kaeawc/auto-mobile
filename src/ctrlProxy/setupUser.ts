import { ActionableError } from "../models/ActionableError";
import { ForegroundUserUnreadableError } from "./ForegroundUserUnreadableError";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice } from "../models";
import { logger } from "../utils/logger";
import type { Timer } from "../utils/SystemTimer";

/**
 * The user CtrlProxy must be set up for, or undefined when the unmodified commands are right (#14918).
 *
 * `pm grant` and `pm path` default to the system user, and on Android Automotive the driver is usually a
 * secondary user (often 10) because the system user is headless. Only a device already known to be
 * automotive (the booted device's form factor, so no extra read) is asked anything: every other device
 * returns undefined without issuing a single command, so the phone path is byte for byte unchanged. On
 * an automotive device the foreground user comes from `am get-current-user`; user 0 (a single-user build,
 * or setup still running) needs no targeting. When the user cannot be read the error names the user
 * problem instead of a generic "accessibility service not enabled".
 */
export async function resolveSetupUser(
  adb: Pick<AdbExecutor, "executeCommand">,
  device: Pick<BootedDevice, "formFactor">,
): Promise<number | undefined> {
  if (device.formFactor !== "automotive") {
    return undefined;
  }
  const current = await adb.executeCommand("shell am get-current-user", { noRetry: true });
  const user = /^\s*(\d+)\s*$/.exec(current.stdout)?.[1];
  if (user === undefined) {
    throw new ForegroundUserUnreadableError(
      `CtrlProxy has to be set up for the foreground user on an automotive device, but \`am get-current-user\` did not return a user id (${JSON.stringify(`${current.stdout}${current.stderr}`.trim())}). Make sure a driver user is signed in and in the foreground, then retry.`,
    );
  }
  const id = Number(user);
  if (id !== 0) {
    return id;
  }
  await assertNotHeadlessSystemUser(adb);
  logger.debug("[CTRL_PROXY] Automotive device reports foreground user 0; no user targeting");
  return undefined;
}

/**
 * The driver user is not in the foreground yet. On a headless-system-user build user 0 has no UI and
 * the driver (often user 10) is switched to after `sys.boot_completed`, so CtrlProxy set up now would
 * land on the wrong user. Runner readiness retries this within its setup budget (#15879).
 */
export class ForegroundUserPendingError extends ActionableError {}

/** Whether `error`, or a cause it wraps, is a {@link ForegroundUserPendingError}. */
export function isForegroundUserPending(error: unknown): boolean {
  for (let current = error, depth = 0; current instanceof Error && depth < 8; depth++) {
    if (current instanceof ForegroundUserPendingError) {
      return true;
    }
    current = current.cause;
  }
  return false;
}

/**
 * User 0 in the foreground is the driver only when the system user is not headless. The property is
 * the one `UserManager.isHeadlessSystemUserMode()` reads; it is read only on an automotive device that
 * reports user 0, so a running driver user costs nothing extra.
 */
async function assertNotHeadlessSystemUser(
  adb: Pick<AdbExecutor, "executeCommand">,
): Promise<void> {
  const headless = await adb.executeCommand("shell getprop ro.fw.mu.headless_system_user", {
    noRetry: true,
  });
  if (headless.stdout.trim() !== "true") {
    return;
  }
  throw new ForegroundUserPendingError(
    "This automotive device runs a headless system user (ro.fw.mu.headless_system_user=true) and " +
      "`am get-current-user` still reports user 0, so the driver user is not in the foreground yet. " +
      "Device readiness waits for the switch; if it never happens, start the driver user with " +
      "`adb shell am switch-user <id>` and retry.",
  );
}

/** ` --user <id>` for a resolved setup user, otherwise the empty string. */
export function userFlag(user: number | undefined): string {
  return user === undefined ? "" : ` --user ${user}`;
}

/** `shell settings [--user <id>] <rest>`, exactly `shell settings <rest>` without a user. */
export function settingsCommand(user: number | undefined, rest: string): string {
  return `shell settings${userFlag(user)} ${rest}`;
}

/** How long the resolved setup user is reused before `am get-current-user` is asked again. */
const SETUP_USER_TTL_MS = 5_000;

/**
 * A memoised {@link resolveSetupUser}: a headless device would otherwise pay an adb round trip per
 * status call, and a user switch is picked up within the window. When the resolved user changes,
 * `onUserChanged` clears the installed and enabled answers, which belong to the previous user.
 */
export function createSetupUserResolver(source: {
  adb: () => Pick<AdbExecutor, "executeCommand">;
  device: () => Pick<BootedDevice, "formFactor">;
  timer: () => Pick<Timer, "now">;
  onUserChanged: () => void;
}): () => Promise<number | undefined> {
  let cached: { user: number | undefined; at: number } | null = null;
  return async () => {
    const now = source.timer().now();
    if (cached && now - cached.at < SETUP_USER_TTL_MS) {
      return cached.user;
    }
    const user = await resolveSetupUser(source.adb(), source.device());
    if (cached && cached.user !== user) {
      source.onUserChanged();
    }
    cached = { user, at: now };
    return user;
  };
}
