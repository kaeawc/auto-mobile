import { ActionableError, toActionableError } from "../../../models/ActionableError";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import { looksLikeMissingIosDefault } from "../../../features/preferences/preferenceValues";
import type { SimulatorKeyboardBridge } from "../../../utils/ios/SimulatorKeyboardBridge";
import type { DeviceMutationResetContext } from "./reset";
import type { DeviceMutationInput } from "./types";
import { simulatorKeyboardRevert } from "./simulatorKeyboardMutation";

/** Runs one owned, abortable simctl command for the reset port. */
export type IosResetCommand = (args: string[]) => Promise<unknown>;

/**
 * The hardware keyboard goes back to its boot state. A language change is undone by selecting
 * the prior keyboard (the running keyboard ignores a `defaults` write of the selection alone),
 * then writing back, or deleting, the keyboard list, language list and selection that call
 * rewrites (#19017).
 */
export async function revertSimulatorKeyboard(
  mutation: DeviceMutationInput,
  context: DeviceMutationResetContext,
  keyboard: SimulatorKeyboardBridge,
  command: IosResetCommand,
): Promise<void> {
  const target = simulatorKeyboardRevert(mutation);
  if (!target) {
    throw new ActionableError("iOS cannot restore an unreadable keyboard state");
  }
  const udid = context.scope.deviceId;
  await context.assertOwned();
  if (target.kind === "hardware") {
    await keyboard.setHardwareKeyboard(udid, target.connected, target.layout, {
      signal: context.signal,
    });
  } else {
    await keyboard.setKeyboardLanguage(udid, target.language, { signal: context.signal });
    for (const entry of [
      [".GlobalPreferences", "AppleKeyboards", target.prior.keyboards],
      [".GlobalPreferences", "AppleLanguages", target.prior.languages],
      ["com.apple.keyboard.preferences", "KeyboardLastUsed", target.prior.current],
    ] as const) {
      await restoreDefault(context, command, entry);
    }
  }
  await context.assertOwned();
}

/** Writes a string or string-array default back, or deletes one that was unset. */
async function restoreDefault(
  context: DeviceMutationResetContext,
  command: IosResetCommand,
  [domain, preference, value]: readonly [string, string, string | readonly string[] | null],
): Promise<void> {
  const udid = context.scope.deviceId;
  if (value !== null) {
    const typed = typeof value === "string" ? ["-string", value] : ["-array", ...value];
    await command(["spawn", udid, "defaults", "write", domain, preference, ...typed]);
    return;
  }
  try {
    await command(["spawn", udid, "defaults", "delete", domain, preference]);
  } catch (error) {
    if (!looksLikeMissingIosDefault(error)) {
      throw toActionableError(error, "iOS keyboard reset command failed");
    }
    // An absent default already satisfies the requested deletion.
    logger.debug(`iOS keyboard default already absent: ${errorMessage(error)}`);
    context.signal.throwIfAborted();
    await context.assertOwned();
  }
}
