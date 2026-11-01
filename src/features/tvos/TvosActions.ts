import { ActionableError, toActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import type {
  SendKeysCommand,
  SendKeysSelector,
  SendKeysFocusOptions,
  SendKeysResult,
} from "../action/SendKeys";
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

/** tvOS typing uses the keyboard opened by remote select; it never resolves a target. */
export async function tvosSendKeys(
  deviceId: string,
  commands: SendKeysCommand[],
  selector?: SendKeysSelector,
  options: SendKeysFocusOptions & { display?: string; signal?: AbortSignal } = {},
): Promise<SendKeysResult> {
  const { signal } = options;
  const unsupported = (): never => {
    throw new ActionableError(
      "tvOS sendKeys supports only type commands into the already focused field; focus it with pressButton select first.",
    );
  };
  if (
    selector !== undefined ||
    options.container !== undefined ||
    options.selectionStrategy !== undefined ||
    options.layer !== undefined ||
    options.display !== undefined
  ) {
    unsupported();
  }
  // Validate the whole request before typing, so unsupported later commands cause no input.
  const typing = commands.map((command) => {
    if (command.action !== "type" || command.text.length === 0) {
      return unsupported();
    }
    return command;
  });
  const results: SendKeysResult["commands"] = [];
  for (const [index, command] of typing.entries()) {
    signal?.throwIfAborted();
    try {
      await tvosRunners
        .require(deviceId)
        .request({ type: "request_append_text", text: command.text }, signal);
    } catch (error) {
      signal?.throwIfAborted();
      const failure = toActionableError(
        error,
        "tvOS text entry failed; focus the field with pressButton select first",
      );
      logger.warn("tvOS sendKeys failed", failure);
      results.push({ index, action: "type", success: false, error: failure.message });
      return {
        success: false,
        completedCommands: index,
        failedIndex: index,
        commands: results,
        error: failure.message,
      };
    }
    results.push({ index, action: "type", success: true, textLength: [...command.text].length });
  }
  return { success: true, completedCommands: results.length, commands: results };
}
