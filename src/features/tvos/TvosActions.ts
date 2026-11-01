import { ActionableError } from "../../models/ActionableError";
import type { Platform, PressButtonResult } from "../../models";
import { TV_REMOTE_BUTTONS, type TVRemoteButton } from "./TvosRunnerClient";
import { tvosRunners } from "./TvosRunnerRegistry";

export function unsupportedTvosAction(action: string): never {
  throw new ActionableError(
    `${action} is not supported on tvOS; use focus navigation via pressButton (up/down/left/right/select).`,
  );
}
export function rejectTvosTouch(platform: Platform, action: string): void {
  if (platform === "tvos") {
    unsupportedTvosAction(action);
  }
}
export async function tvosPress(
  deviceId: string,
  button: string,
  signal?: AbortSignal,
): Promise<PressButtonResult> {
  const action = TV_REMOTE_BUTTONS.find((value): value is TVRemoteButton => value === button);
  if (!action) {
    unsupportedTvosAction(`press ${button}`);
  }
  signal?.throwIfAborted();
  await tvosRunners.require(deviceId).request({ type: "request_press_button", action }, signal);
  return { success: true, button, keyCode: 0 };
}
