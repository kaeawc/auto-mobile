import { ActionableError, toActionableError } from "../../models/ActionableError";
import type {
  SendKeysCommand,
  SendKeysSelector,
  SendKeysFocusOptions,
  SendKeysResult,
} from "../action/SendKeys";
import { logger } from "../../utils/logger";
import { watchTapOn } from "./WatchActions";
import { watchRunners } from "./WatchRunnerRegistry";

/** XCUIKeyboardKey delete, macOS delete and forwardDelete. */
const DELETE_KEY_CHARACTERS = new Set(["\u0008", "\u007f", "\uf728"]);

function validateWatchInput(
  commands: SendKeysCommand[],
  selector: SendKeysSelector | undefined,
  options: SendKeysFocusOptions & { display?: string },
) {
  if (
    options.container !== undefined ||
    options.selectionStrategy !== undefined ||
    options.layer !== undefined ||
    options.display !== undefined ||
    commands.length === 0
  ) {
    throw new ActionableError(
      "watchOS sendKeys supports only type commands into the focused field; focus it with tapOn first.",
    );
  }
  if (
    selector !== undefined &&
    (selector.testTag !== undefined ||
      selector.textAny !== undefined ||
      (selector.elementId === undefined && selector.text === undefined))
  ) {
    throw new ActionableError(
      "watchOS sendKeys selector supports only exact elementId or text; focus the field with tapOn first.",
    );
  }
  // Validate the complete batch before issuing any input.
  return commands.map((command) => {
    if (
      command.action !== "type" ||
      !command.text ||
      command.operation === "replace" ||
      (command.mode !== undefined && command.mode !== "auto") ||
      command.keyboardProfile !== undefined
    ) {
      throw new ActionableError(
        "watchOS sendKeys supports only non-empty append type commands; focus the field with tapOn first.",
      );
    }
    if ([...command.text].some((char) => DELETE_KEY_CHARACTERS.has(char))) {
      throw new ActionableError(
        "watchOS sendKeys appends text only; text containing a delete key would erase existing content.",
      );
    }
    return command;
  });
}

/** Append only: the runner refuses input unless a text field already has focus. */
export async function watchSendKeys(
  deviceId: string,
  commands: SendKeysCommand[],
  selector?: SendKeysSelector,
  options: SendKeysFocusOptions & { display?: string; signal?: AbortSignal } = {},
): Promise<SendKeysResult> {
  const typing = validateWatchInput(commands, selector, options);
  const { signal } = options;
  signal?.throwIfAborted();
  const client = watchRunners.require(deviceId);
  if (selector !== undefined) {
    await watchTapOn(deviceId, { action: "tap", ...selector }, signal, true);
  }
  const results: SendKeysResult["commands"] = [];
  for (const [index, command] of typing.entries()) {
    signal?.throwIfAborted();
    try {
      await client.request({ type: "type", text: command.text }, signal);
    } catch (error) {
      signal?.throwIfAborted();
      const failure = toActionableError(
        error,
        "watchOS text entry failed; focus a text field with tapOn first",
      );
      logger.warn(failure.message, error);
      results.push({
        index,
        action: "type",
        success: false,
        resolvedMode: "xcuiTypeText",
        error: failure.message,
      });
      return {
        success: false,
        completedCommands: index,
        failedIndex: index,
        commands: results,
        error: failure.message,
      };
    }
    results.push({
      index,
      action: "type",
      success: true,
      textLength: [...command.text].length,
      resolvedMode: "xcuiTypeText",
    });
  }
  return { success: true, completedCommands: results.length, commands: results };
}
