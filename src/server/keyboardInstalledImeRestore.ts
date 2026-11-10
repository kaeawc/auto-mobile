import type { BootedDevice } from "../models";
import {
  pendingImeRestores,
  type PendingImeRestoreRegistry,
} from "../features/action/sendkeys/PendingImeRestore";
import { flushPendingImeRestoreBeforeTool } from "./pipeline/deviceCallDispatch";
import type { KeyboardArgs } from "./interactionToolTypes";

/** keyboard actions that act on the installed keyboard rather than the AutoMobile IME. */
const INSTALLED_IME_ACTIONS: ReadonlySet<KeyboardArgs["action"]> = new Set([
  "listImes",
  "setIme",
  "tapImeKey",
]);

/**
 * Restores the keyboard sendKeys replaced before an installed-IME keyboard action (#16428).
 * Every other keyboard action leaves the AutoMobile IME selected until session release.
 */
export function withInstalledImeRestore<R, Rest extends unknown[]>(
  handler: (device: BootedDevice, args: KeyboardArgs, ...rest: Rest) => Promise<R>,
  registry: Pick<PendingImeRestoreRegistry, "flush"> = pendingImeRestores,
): (device: BootedDevice, args: KeyboardArgs, ...rest: Rest) => Promise<R> {
  return async (device, args, ...rest) => {
    if (device.platform === "android" && INSTALLED_IME_ACTIONS.has(args.action)) {
      await flushPendingImeRestoreBeforeTool(device.deviceId, registry);
    }
    return handler(device, args, ...rest);
  };
}
