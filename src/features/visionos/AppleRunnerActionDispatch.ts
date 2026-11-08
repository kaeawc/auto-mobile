import type { BootedDevice, Platform, TapOnElementOptions, TapOnElementResult } from "../../models";
import type { SendKeysCommand, SendKeysSelector, SendKeysFocusOptions } from "../action/SendKeys";
import { tvosSendKeys } from "../tvos/TvosActions";
import { tvosTapOn } from "../tvos/TvosFocusNavigation";
import { watchSendKeys } from "../watch/WatchSendKeys";
import { watchTapOn } from "../watch/WatchActions";
import { visionosSendKeys, visionosTapOn } from "./VisionosActions";

/** Apple runner trees use iOS selector conventions without iOS panel selection. */
export function usesAppleRunnerHierarchy(platform: Platform): boolean {
  return platform === "watchos" || platform === "tvos" || platform === "visionos";
}

/** Return undefined only when the normal Android/iOS tap pipeline owns dispatch. */
export function tapOnAppleRunner(
  device: BootedDevice,
  options: TapOnElementOptions,
  signal?: AbortSignal,
): Promise<TapOnElementResult> | undefined {
  switch (device.platform) {
    case "visionos":
      return visionosTapOn(device.deviceId, options, signal);
    case "tvos":
      return tvosTapOn(device.deviceId, options, signal);
    case "watchos":
      return watchTapOn(device.deviceId, options, signal);
    default:
      return undefined;
  }
}

/** Apple runners append text to a focused field. */
export function sendKeysToAppleRunner(
  device: BootedDevice,
  commands: SendKeysCommand[],
  selector?: SendKeysSelector,
  options: SendKeysFocusOptions & { display?: string; signal?: AbortSignal } = {},
) {
  const send =
    device.platform === "watchos"
      ? watchSendKeys
      : device.platform === "visionos"
        ? visionosSendKeys
        : tvosSendKeys;
  return send(device.deviceId, commands, selector, options);
}
