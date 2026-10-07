import type { ObserveResult, ViewHierarchyNode } from "../../models";
import { nodeAttributes } from "../../models/ViewHierarchyResult";
import { DefaultElementParser } from "../utility/ElementParser";
import { getFocusedTextField, type FocusedTextField } from "./ClearText";
import type { ObserveScreenExecuteOptions } from "../observe/interfaces/ObserveScreen";
import type { Timer } from "../../utils/SystemTimer";
import { raceWithDeadline } from "../../utils/raceWithDeadline";
import { getTextRequestDeadlineMs } from "./textTransportTimeout";
import { combineAbortSignals, combineWithAmbientAbort } from "../../utils/AbortContext";
import { logger } from "../../utils/logger";

/** Keep secure values out of the shared focused-field reader, including its property copies. */
class SecureValueOmittingParser extends DefaultElementParser {
  override extractNodeProperties(node: ViewHierarchyNode): Record<string, unknown> {
    const attributes = nodeAttributes(node);
    const nodeClass = attributes.class ?? attributes.className;
    if (
      attributes.password === true ||
      attributes.password === "true" ||
      (typeof nodeClass === "string" && nodeClass.includes("SecureTextField"))
    ) {
      return {
        focused: attributes.focused,
        class: nodeClass,
        password: true,
        editable: attributes.editable,
        actions: attributes.actions,
      };
    }
    return super.extractNodeProperties(node);
  }
}

export interface IosTypedTextVerificationResult {
  success: boolean;
  error?: string;
  warning?: string;
}

/** Literal Unicode characters in order; intervening mask characters are allowed. */
export function compareIosTypedText(
  text: string,
  before: FocusedTextField | undefined,
  after: FocusedTextField | undefined,
): IosTypedTextVerificationResult {
  if (before?.secure || after?.secure) {
    return { success: true, warning: "iOS typed text check skipped for a secure field." };
  }
  if (before?.value === undefined || after?.value === undefined) {
    return {
      success: true,
      warning: "iOS typed text result was not verified: the focused field could not be read.",
    };
  }
  if (before.value === after.value) {
    return {
      success: false,
      error: "iOS nothing was typed: the focused field value is unchanged.",
    };
  }
  return containsTypedCharacters(after.value, text)
    ? { success: true }
    : {
        success: true,
        warning: `iOS typed text changed in the focused field; observed value: ${JSON.stringify(after.value)}.`,
      };
}

function containsTypedCharacters(value: string, text: string): boolean {
  const characters = Array.from(text);
  let matched = 0;
  for (const character of value) {
    if (character === characters[matched]) {
      matched++;
    }
  }
  return matched === characters.length;
}

export interface IosTypedTextObserver {
  execute(options?: ObserveScreenExecuteOptions): Promise<ObserveResult>;
}

/** One fresh hierarchy-only read, bounded even when a client ignores cancellation. */
export async function readIosTypedTextField(
  observer: IosTypedTextObserver,
  timer: Timer,
  signal?: AbortSignal,
  display?: string,
): Promise<FocusedTextField | undefined> {
  const requestSignal = combineWithAmbientAbort(signal);
  const deadline = getTextRequestDeadlineMs();
  const remaining = deadline === undefined ? undefined : deadline - timer.now();
  if (requestSignal?.aborted || (remaining !== undefined && remaining <= 0)) {
    return undefined;
  }
  const controller = new AbortController();
  const readSignal = combineAbortSignals(requestSignal, controller.signal);
  try {
    const observation = await raceWithDeadline(
      () =>
        observer.execute({
          freshness: "fresh",
          skipScreenshot: true,
          skipAccessibilityAudit: true,
          signal: readSignal,
          timeoutMs: remaining,
          ...(display === undefined ? {} : { display }),
        }),
      {
        timer,
        timeoutMs: remaining,
        signal: readSignal,
        label: "iOS typed text verification",
        onTimeout: () => controller.abort(),
      },
    );
    const hierarchy = observation.viewHierarchy;
    return observation.freshness?.isFresh === false || !hierarchy || hierarchy.hierarchy.error
      ? undefined
      : getFocusedTextField(hierarchy, new SecureValueOmittingParser());
  } catch {
    // Best-effort verification must preserve a confirmed delivery; never log field/transport values.
    logger.warn("[iOS typed text] Focused field read unavailable; result cannot be verified");
    return undefined;
  }
}

export async function verifyIosTypedText(
  text: string,
  before: FocusedTextField | undefined,
  observer: IosTypedTextObserver,
  timer: Timer,
  signal?: AbortSignal,
  display?: string,
): Promise<IosTypedTextVerificationResult> {
  if (before?.secure) {
    return compareIosTypedText(text, before, undefined);
  }
  return compareIosTypedText(
    text,
    before,
    await readIosTypedTextField(observer, timer, signal, display),
  );
}
