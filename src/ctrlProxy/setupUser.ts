import { ActionableError } from "../models/ActionableError";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice } from "../models";
import { logger } from "../utils/logger";

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
    throw new ActionableError(
      `CtrlProxy has to be set up for the foreground user on an automotive device, but \`am get-current-user\` did not return a user id (${JSON.stringify(`${current.stdout}${current.stderr}`.trim())}). Make sure a driver user is signed in and in the foreground, then retry.`,
    );
  }
  const id = Number(user);
  if (id === 0) {
    logger.debug("[CTRL_PROXY] Automotive device reports foreground user 0; no user targeting");
  }
  return id === 0 ? undefined : id;
}

/** ` --user <id>` for a resolved setup user, otherwise the empty string. */
export function userFlag(user: number | undefined): string {
  return user === undefined ? "" : ` --user ${user}`;
}

/** `shell settings [--user <id>] <rest>`, exactly `shell settings <rest>` without a user. */
export function settingsCommand(user: number | undefined, rest: string): string {
  return `shell settings${userFlag(user)} ${rest}`;
}
