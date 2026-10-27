import { ActionableError } from "../models/ActionableError";
import type { AdbExecutor } from "../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { BootedDevice } from "../models";

/** Set to `true` on builds whose system user (0) is headless: the driver is a secondary user. */
export const HEADLESS_SYSTEM_USER_PROP = "ro.fw.mu.headless_system_user";

/**
 * The user CtrlProxy must be set up for, or undefined when the unmodified commands (which act on the
 * system user) are right (#14918).
 *
 * Only a device already known to be automotive (the booted device's form factor, so no extra read) that
 * also reports a headless system user is asked anything: every other device returns undefined without
 * issuing a single command, so the phone path is byte for byte unchanged. On a headless build the foreground user comes from `am get-current-user`; when that
 * cannot be read the error names the user problem instead of a generic "accessibility service not
 * enabled".
 */
export async function resolveSetupUser(
  adb: Pick<AdbExecutor, "executeCommand">,
  device: Pick<BootedDevice, "formFactor">,
): Promise<number | undefined> {
  if (device.formFactor !== "automotive") {
    return undefined;
  }
  const headless = await adb.executeCommand(`shell getprop ${HEADLESS_SYSTEM_USER_PROP}`, {
    noRetry: true,
  });
  if (headless.stdout.trim().toLowerCase() !== "true") {
    return undefined;
  }
  const current = await adb.executeCommand("shell am get-current-user", { noRetry: true });
  const user = /^\s*(\d+)\s*$/.exec(current.stdout)?.[1];
  if (user === undefined) {
    throw new ActionableError(
      `This device has a headless system user, so CtrlProxy has to be set up for the foreground user, but \`am get-current-user\` did not return a user id (${JSON.stringify(`${current.stdout}${current.stderr}`.trim())}). Make sure a driver user is signed in and in the foreground, then retry.`,
    );
  }
  const id = Number(user);
  // The headless system user is never in the foreground; if it reports 0 there is nothing to target.
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
