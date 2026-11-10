import { ActionableError, toActionableError } from "../../models/ActionableError";
import type {
  SendKeysCommand,
  SendKeysSelector,
  SendKeysFocusOptions,
  SendKeysResult,
} from "../action/SendKeys";
import { logger } from "../../utils/logger";
import { DefaultRetryExecutor } from "../../utils/retry/RetryExecutor";
import type { Timer } from "../../utils/SystemTimer";
import { watchTapOn } from "./WatchActions";
import { WatchRunnerError } from "./WatchRunnerError";
import type { WatchRunnerClient } from "./WatchRunnerClient";
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

/**
 * Delays between type attempts while a selector's tap is still presenting the keyboard sheet
 * (#17359). Bounds the wait to about 1.5 s before the runner's focus refusal is reported.
 */
export const WATCH_FOCUS_WAIT_DELAYS_MS: readonly number[] = [50, 100, 200, 250, 250, 250, 250];

/**
 * The runner checks keyboard focus and the keyboard sheet before typing and refuses with this
 * message without typing anything, so a refused type is a side-effect-free focus read.
 */
function isNotFocusedYet(error: Error): boolean {
  return (
    error instanceof WatchRunnerError &&
    error.errorCode === "command_failed" &&
    error.message.startsWith("No focused text field")
  );
}

/** The hierarchy carries no keyboard-focus state, so the runner's own focus check is the poll. */
async function typeOnceFocused(
  client: WatchRunnerClient,
  text: string,
  timer: Timer | undefined,
  signal: AbortSignal | undefined,
): Promise<void> {
  await new DefaultRetryExecutor(timer).executeOrThrow(
    () => client.request({ type: "type", text }, signal).then(() => undefined),
    {
      maxAttempts: WATCH_FOCUS_WAIT_DELAYS_MS.length + 1,
      delays: WATCH_FOCUS_WAIT_DELAYS_MS,
      signal,
      shouldRetry: isNotFocusedYet,
      expectedFailure: {
        reason: "sendKeys reports the focus refusal as a failed command",
        matches: isNotFocusedYet,
      },
    },
  );
}

/** Append only: the runner refuses input unless a text field already has focus. */
export async function watchSendKeys(
  deviceId: string,
  commands: SendKeysCommand[],
  selector?: SendKeysSelector,
  options: SendKeysFocusOptions & { display?: string; signal?: AbortSignal; timer?: Timer } = {},
): Promise<SendKeysResult> {
  const typing = validateWatchInput(commands, selector, options);
  const { signal, timer } = options;
  signal?.throwIfAborted();
  const client = watchRunners.require(deviceId);
  // The call's only tap, so its Smart Stack preflight runs once per call, never per key (#17803).
  if (selector !== undefined) {
    await watchTapOn(deviceId, { action: "tap", ...selector }, signal, true);
  }
  const results: SendKeysResult["commands"] = [];
  for (const [index, command] of typing.entries()) {
    signal?.throwIfAborted();
    try {
      // Only the selector's own tap can still be opening the keyboard sheet.
      if (index === 0 && selector !== undefined) {
        await typeOnceFocused(client, command.text, timer, signal);
      } else {
        await client.request({ type: "type", text: command.text }, signal);
      }
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
