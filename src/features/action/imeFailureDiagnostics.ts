import type { ObserveResult } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { DefaultElementParser } from "../utility/ElementParser";
import { toSearchable } from "../utility/SearchableNode";
import { FieldTypeDetector } from "./FieldTypeDetector";
import type { TextActionResult } from "./SendKeys";
import {
  imeCommitSubsequenceMatches,
  imeCommitSuffixMatches,
} from "../observe/android/CtrlProxyText";

export interface ImeFailureDiagnostic {
  stage:
    | "unsupportedCapability"
    | "activationBinding"
    | "commit"
    | "verification"
    | "transport"
    | "restoration";
  /** Original failure, before host progress/restoration guidance is appended. */
  cause: string;
  expectedText: string;
  /** Null means no readable value was captured, not an empty editor. */
  observedText: string | null;
  focusedFieldClass: string | null;
  textMayHaveBeenApplied: boolean;
  /** Conservative device dispatch upper bound, never a verified count. */
  committedUnits?: number;
  /** Present only when the backend supplied verified progress. */
  verifiedGraphemes?: number;
}

/** Whether the observation's focused editable field is a password field. */
export function focusedFieldIsPassword(observation: ObserveResult): boolean {
  const detector = new FieldTypeDetector();
  const focused = observation.focusedElement;
  if (focused && String(focused.focused) === "true" && detector.isPasswordField(focused)) {
    return true;
  }
  if (!observation.viewHierarchy) {
    return false;
  }
  const parser = new DefaultElementParser();
  let password = false;
  for (const root of parser.extractRootNodes(observation.viewHierarchy)) {
    parser.traverseNode(root, (node) => {
      const element = parser.extractNodeProperties(node);
      if (String(element.focused) === "true" && detector.isPasswordField(element)) {
        password = true;
      }
    });
  }
  return password;
}

/** Uses the existing typed hierarchy parser; never reconstructs an editor from error prose. */
export function focusedImeFieldClass(observation: ObserveResult): string | null {
  const detector = new FieldTypeDetector();
  const focused = observation.focusedElement;
  if (focused && String(focused.focused) === "true" && detector.detect(focused) === "text") {
    return toSearchable(focused).className ?? null;
  }
  if (!observation.viewHierarchy) {
    return null;
  }
  const parser = new DefaultElementParser();
  for (const roots of parser
    .extractWindowRootGroups(observation.viewHierarchy, "topmost-first")
    .concat([parser.extractRootNodes(observation.viewHierarchy)])) {
    for (const root of roots) {
      let fieldClass: string | null = null;
      parser.traverseNode(root, (node) => {
        const properties = parser.extractNodeProperties(node);
        if (
          fieldClass === null &&
          String(properties.focused) === "true" &&
          detector.detect(properties) === "text"
        ) {
          fieldClass = toSearchable(properties).className ?? null;
        }
      });
      if (fieldClass !== null) {
        return fieldClass;
      }
    }
  }
  return null;
}

// Exact messages emitted before any commit in the current CtrlProxy protocol.
// Unknown/older errors remain conservative; a zero/absent dispatch count proves nothing.
const BINDING_FAILURES = new Set([
  "IME service did not start within timeout",
  "No active input connection within timeout",
  "No active input connection",
]);

/** The refusal an older CtrlProxy (without `ime_password_commit_v1`) returns for password fields. */
export const LEGACY_IME_PASSWORD_REFUSAL = "Cannot commit text into a password field";

export const IME_PASSWORD_COMMIT_UNAVAILABLE_ERROR =
  "IME typing into a password field needs the CtrlProxy ime_password_commit_v1 capability. " +
  'Update the CtrlProxy APK, then retry, or use mode: "auto" to type through key events or accessibility.';

/** Stands in for password text wherever typed input would otherwise reach a log or diagnostic. */
export function passwordTextPlaceholder(text: string): string {
  return `<password, ${Array.from(text).length} characters>`;
}

/** Keep the failure shape for a password field, but never carry the typed or read-back value. */
export function redactPasswordImeFailure<T extends TextActionResult>(result: T, text: string): T {
  if (!result.imeFailure) {
    return result;
  }
  return {
    ...result,
    imeFailure: {
      ...result.imeFailure,
      expectedText: passwordTextPlaceholder(text),
      observedText: null,
    },
  };
}

export function withImeFailure<T extends TextActionResult>(
  result: T,
  text: string,
  stage: ImeFailureDiagnostic["stage"],
  context: {
    focusedFieldClass?: string | null;
    observedText?: string;
    textMayHaveBeenApplied?: boolean;
  } = {},
): T {
  if (result.success || result.imeFailure) {
    return result;
  }
  stage = result.imeFailureStage ?? stage;
  const bindingFailure =
    stage === "commit" && BINDING_FAILURES.has(result.error ?? "") && !hasImeProgress(result);
  const applied = imeTextMayHaveBeenApplied(
    result,
    stage,
    bindingFailure,
    context.textMayHaveBeenApplied,
  );
  return {
    ...result,
    imeFailure: {
      stage: bindingFailure ? "activationBinding" : stage,
      cause: result.error ?? "IME commit failed",
      expectedText: text,
      observedText: context.observedText ?? null,
      focusedFieldClass: context.focusedFieldClass ?? null,
      textMayHaveBeenApplied: applied,
      committedUnits: result.committedUnits,
      verifiedGraphemes: result.committedGraphemes,
    },
  };
}

function hasImeProgress(result: TextActionResult): boolean {
  return (
    result.partialApplication === true ||
    (result.committedUnits ?? 0) > 0 ||
    (result.committedGraphemes ?? 0) > 0
  );
}

function imeTextMayHaveBeenApplied(
  result: TextActionResult,
  stage: ImeFailureDiagnostic["stage"],
  bindingFailure: boolean,
  knownApplied?: boolean,
): boolean {
  return (
    hasImeProgress(result) ||
    (knownApplied ??
      (!bindingFailure && stage !== "activationBinding" && stage !== "unsupportedCapability"))
  );
}

export function imeFailureFields(result: TextActionResult): Pick<TextActionResult, "imeFailure"> {
  return result.imeFailure ? { imeFailure: result.imeFailure } : {};
}

/** Abort failures retain the caller's restoration-before-rethrow path. */
function isImeCommitAbort(error: unknown, signal?: AbortSignal): boolean {
  return signal?.aborted === true || (error instanceof Error && error.name === "AbortError");
}

export function imeCommitExceptionResult(
  error: unknown,
  signal: AbortSignal | undefined,
  result: TextActionResult,
  text: string,
  focusedFieldClass?: string | null,
): { outcome?: TextActionResult; failure?: unknown } {
  if (isImeCommitAbort(error, signal)) {
    return { failure: error };
  }
  logger.warn("[SendKeys] IME transport failed", error);
  return {
    outcome: withImeFailure(
      { ...result, success: false, error: errorMessage(error) },
      text,
      "transport",
      { focusedFieldClass },
    ),
  };
}

interface ImeVerification {
  timer: Timer;
  settleMs: number;
  observe(): Promise<ObserveResult>;
  checkAbort(error?: unknown): void;
  lacksRequiredFocus(observation: ObserveResult): boolean;
  focusedText(observation: ObserveResult): string | undefined;
  focusError: string;
  /** A password field's value is masked, and the typed text must never appear in diagnostics. */
  passwordField?: boolean;
  /** Detects a focused password field in a read-back observation (explicit modes). */
  isPasswordField?(observation: ObserveResult): boolean;
}

/** Preserve existing bounded verification semantics, adding the final read-back evidence. */
export async function verifyImeCommitResult(
  result: TextActionResult,
  text: string,
  verification: ImeVerification,
): Promise<TextActionResult> {
  let sawPassword = verification.passwordField === true;
  const verified = await verifyImeCommitReadBack(result, text, {
    ...verification,
    observe: async () => {
      const observation = await verification.observe();
      sawPassword ||= verification.isPasswordField?.(observation) === true;
      return observation;
    },
    get passwordField() {
      return sawPassword;
    },
  });
  return sawPassword ? redactPasswordImeFailure(verified, text) : verified;
}

async function verifyImeCommitReadBack(
  result: TextActionResult,
  text: string,
  verification: ImeVerification,
): Promise<TextActionResult> {
  try {
    for (let attempt = 0; attempt < 3; attempt++) {
      verification.checkAbort();
      if (attempt > 0) {
        await verification.timer.sleep(verification.settleMs);
        verification.checkAbort();
      }
      const observation = await verification.observe();
      verification.checkAbort();
      const observedText = verification.focusedText(observation);
      const context = { observedText, focusedFieldClass: focusedImeFieldClass(observation) };
      if (verification.lacksRequiredFocus(observation)) {
        return withImeFailure(
          { ...result, success: false, partialApplication: true, error: verification.focusError },
          text,
          "verification",
          context,
        );
      }
      if (observedText === undefined) {
        return result;
      }
      const suffixMatches = imeCommitSuffixMatches(observedText, text);
      // Editors can consume markers or add prefixes across multiple segments.
      // Pre-existing insert content can satisfy this check; replace clears the field first.
      if (suffixMatches !== false || imeCommitSubsequenceMatches(observedText, text)) {
        return result;
      }
      if (attempt === 2) {
        return withImeFailure(
          {
            ...result,
            success: false,
            partialApplication: true,
            error: verification.passwordField
              ? `IME partial commit: sent ${passwordTextPlaceholder(text)} but the focused field holds a different value`
              : `IME partial commit: sent ${JSON.stringify(text)} but the focused field holds ${JSON.stringify(observedText)}`,
          },
          text,
          "verification",
          context,
        );
      }
    }
  } catch (error) {
    verification.checkAbort(error);
    logger.warn(`[SendKeys] IME read-back unavailable: ${errorMessage(error)}`, error);
  }
  return result;
}
