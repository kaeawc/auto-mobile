import type { BootedDevice } from "../../../models";
import { getFocusedTextField } from "../ClearText";
import { isPrintableAscii } from "./AndroidTypingConstants";
import type {
  SendKeysKey,
  SendKeysOperation,
  SendKeysSemanticKey,
  SendKeysTypeCommand,
  TextActionResult,
} from "../SendKeys";

export const SEND_KEYS_SEMANTIC_KEYS = [
  "next",
  "previous",
  "done",
  "search",
  "send",
  "go",
] as const;

export function validateImeKeyEventsText(
  command: SendKeysTypeCommand,
  platform: BootedDevice["platform"],
): string | null {
  if (
    platform === "android" &&
    command.mode === "imeKeyEvents" &&
    !isPrintableAscii(command.text)
  ) {
    return "imeKeyEvents accepts printable ASCII (U+0020–U+007E) only; use mode: ime for other text.";
  }
  return null;
}

/** The text already in the focused field that a case read-back must not count; none on replace. */
export function preExistingFieldText(
  hierarchy: Parameters<typeof getFocusedTextField>[0],
  operation: SendKeysOperation,
): string {
  return operation === "replace" ? "" : (getFocusedTextField(hierarchy)?.value ?? "");
}

export function isSemanticKey(key: SendKeysKey): key is SendKeysSemanticKey {
  return (SEND_KEYS_SEMANTIC_KEYS as readonly string[]).includes(key);
}

export function markPartialAfterMutation(result: TextActionResult): TextActionResult {
  return result.success || result.partialApplication
    ? result
    : { ...result, partialApplication: true };
}

export function markPartialAfterPriorMutation(
  result: TextActionResult,
  previouslyMutated: boolean,
): TextActionResult {
  return previouslyMutated ? markPartialAfterMutation(result) : result;
}
