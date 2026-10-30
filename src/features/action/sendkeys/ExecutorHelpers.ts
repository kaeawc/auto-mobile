import { getFocusedTextField } from "../ClearText";
import type { ObserveResult } from "../../../models";
import {
  IME_PASSWORD_COMMIT_UNAVAILABLE_ERROR,
  LEGACY_IME_PASSWORD_REFUSAL,
  redactPasswordImeFailure,
} from "../imeFailureDiagnostics";
import type { KeyboardProfileId } from "../keyboardProfiles";
import { FieldTypeDetector } from "../FieldTypeDetector";
import { DefaultElementParser } from "../../utility/ElementParser";
import type {
  AndroidSendKeysTypingMode,
  SendKeysCommandResult,
  SendKeysInputKey,
  SendKeysOperation,
  SendKeysTypingMode,
  TextActionResult,
} from "../SendKeys";

export function hasFocusedPasswordField(
  hierarchy: NonNullable<ObserveResult["viewHierarchy"]>,
): boolean {
  const parser = new DefaultElementParser();
  const detector = new FieldTypeDetector();
  for (const root of parser.extractRootNodes(hierarchy)) {
    let password = false;
    parser.traverseNode(root, (node) => {
      const element = parser.extractNodeProperties(node);
      if (
        (element.focused === true || element.focused === "true") &&
        detector.isPasswordField(element)
      ) {
        password = true;
      }
    });
    if (password) {
      return true;
    }
  }
  return false;
}

export function graphemeCodePoints(graphemes: string[]): string {
  return graphemes
    .map((grapheme) =>
      Array.from(
        grapheme,
        (char) => `U+${char.codePointAt(0)!.toString(16).toUpperCase().padStart(4, "0")}`,
      ).join(" "),
    )
    .join(", ");
}

/** An older CtrlProxy refused the IME commit because the focused field is a password field. */
export function isLegacyImePasswordRefusal(result: TextActionResult): boolean {
  return (
    result.error === LEGACY_IME_PASSWORD_REFUSAL ||
    result.imeFailure?.cause === LEGACY_IME_PASSWORD_REFUSAL
  );
}

/**
 * A password field's typed text never reaches a diagnostic. An older CtrlProxy's password refusal
 * names the APK update: explicit IME mode never switches delivery on its own.
 */
export function redactPasswordTypeResult(
  result: TextActionResult,
  text: string,
  passwordField: boolean,
): void {
  const legacyRefusal = isLegacyImePasswordRefusal(result);
  if (passwordField || legacyRefusal) {
    Object.assign(result, redactPasswordImeFailure(result, text));
  }
  if (legacyRefusal) {
    result.error = IME_PASSWORD_COMMIT_UNAVAILABLE_ERROR;
  }
}

export function getAutoImeFallback(
  operation: SendKeysOperation,
  requestedMode: SendKeysTypingMode,
  keyboardProfile: KeyboardProfileId | undefined,
  {
    resolvedMode,
    passwordField,
  }: { resolvedMode: AndroidSendKeysTypingMode; passwordField?: boolean },
): AndroidSendKeysTypingMode | undefined {
  // A password field typed through the IME has no safe fallback: eventAll would need the
  // up-front deliverability check, and a mid-run switch could leave part of it typed.
  if (requestedMode !== "auto" || keyboardProfile || resolvedMode !== "ime" || passwordField) {
    return undefined;
  }
  return operation === "insert" ? "eventAll" : "a11y";
}

/** The optional outcome fields of an InputKey press, copied onto a sendKeys key result. */
export function inputKeyOutcomeFields(
  result: Awaited<ReturnType<SendKeysInputKey["press"]>>,
): Pick<SendKeysCommandResult, "verified" | "warning" | "error" | "errorCode"> {
  return {
    ...(result.verified === undefined ? {} : { verified: result.verified }),
    ...(result.warning === undefined ? {} : { warning: result.warning }),
    ...(result.error ? { error: result.error } : {}),
    ...(result.errorCode === undefined ? {} : { errorCode: result.errorCode }),
  };
}

/** The text already in the focused field that a case read-back must not count; none on replace. */
export function preExistingFieldText(
  hierarchy: Parameters<typeof getFocusedTextField>[0],
  operation: SendKeysOperation,
): string {
  return operation === "replace" ? "" : (getFocusedTextField(hierarchy)?.value ?? "");
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
