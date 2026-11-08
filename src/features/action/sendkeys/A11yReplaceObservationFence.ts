import type { ObserveResult } from "../../../models";
import type { Timer } from "../../../utils/SystemTimer";
import { getFocusedTextField } from "../ClearText";
import { imeInsertedTextMatches } from "../../observe/android/CtrlProxyText";
import type { SendKeysCommand, SendKeysCommandExecution } from "../SendKeys";
import { readBackWithSettle } from "./readBackWithSettle";

export const A11Y_REPLACE_OBSERVATION_STALE_WARNING =
  "The observation may predate the accessibility text change: the focused field did not show the " +
  "requested text within the read-back window. Observe again before retrying.";

/**
 * The text an a11y `replace` set, when it is the last command and it succeeded. Only then must
 * the terminal observation show that text; any later command may legitimately change the field.
 */
export function a11yReplaceExpectedText(
  commands: readonly SendKeysCommand[],
  execution: SendKeysCommandExecution,
): string | undefined {
  if (execution.failure || commands.length === 0) {
    return undefined;
  }
  const command = commands[commands.length - 1]!;
  const result = execution.results[commands.length - 1];
  return command.action === "type" &&
    command.operation === "replace" &&
    command.text.length > 0 &&
    result?.success === true &&
    result.resolvedMode === "a11y"
    ? command.text
    : undefined;
}

/**
 * Whether the observation shows the replaced text. An unreadable, secure or absent focused field
 * cannot be compared and is accepted as-is, so the fence never waits on evidence it cannot read.
 */
function showsReplacedText(observation: ObserveResult, expected: string): boolean {
  const field = observation.viewHierarchy
    ? getFocusedTextField(observation.viewHierarchy)
    : undefined;
  if (!field || field.secure || field.value === undefined) {
    return true;
  }
  // A formatter may add separators to the set value (e.g. "5125550142" -> "(512) 555-0142").
  return field.value === expected || imeInsertedTextMatches(field.value, expected);
}

/**
 * The accessibility `ACTION_SET_TEXT` returns before the hierarchy reflects it (#17462). Re-observe
 * with the bounded read-back settle until the focused field shows the requested text; otherwise
 * return the last observation and say it may be stale.
 */
export function observeAfterA11yReplace(
  expected: string,
  observe: () => Promise<ObserveResult>,
  options: { timer: Timer; checkAbort(): void },
): Promise<{ observation: ObserveResult; warning?: string }> {
  return readBackWithSettle(observe, (observation) => showsReplacedText(observation, expected), {
    timer: options.timer,
    beforeRead: options.checkAbort,
    finish: (observation, accepted) =>
      accepted
        ? { observation: observation! }
        : { observation: observation!, warning: A11Y_REPLACE_OBSERVATION_STALE_WARNING },
  });
}
