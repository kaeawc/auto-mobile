import type { Element, ViewHierarchyResult } from "../../models";
import type { TapOnElementOptions } from "../../models/TapOnElementOptions";
import { logger } from "../../utils/logger";
import { isElementKeyboardFocused } from "../utility/FocusedInput";
import { isFocusEditableElement } from "../utility/ElementResolver";
import { describeFocusTarget } from "./tapFocusIdentity";
import {
  resolvedElementLayer,
  withResolvedLayer,
  type TapOnFocusOutcome,
  type TapOnFocusResult,
} from "./tapResultMarkers";

/** What the focus-entry phase needs from the owning tap action. */
export interface TapFocusEntryHost {
  readonly platform: "android" | "ios";
}

export interface TapFocusEntryInput {
  options: TapOnElementOptions;
  element: Element;
  matchedElement: Element | null | undefined;
  selectedElement: TapOnFocusResult["selectedElement"];
  searchUntil: TapOnFocusResult["searchUntil"];
  viewHierarchy: ViewHierarchyResult;
  tapPoint: { x: number; y: number };
}

/** Either a finished outcome (not editable / already focused) or a go-ahead to tap, with the label text. */
export type TapFocusEntryDecision =
  | { kind: "done"; outcome: TapOnFocusOutcome }
  | { kind: "tap"; labelText: string | undefined };

/** Decide whether a `focus` request needs a tap at all. */
export class TapFocusEntryPhase {
  constructor(private readonly host: TapFocusEntryHost) {}

  resolve(input: TapFocusEntryInput): TapFocusEntryDecision {
    const { options, element, selectedElement, searchUntil, viewHierarchy, tapPoint } = input;
    const action = "focus";
    if (!isFocusEditableElement(element)) {
      return {
        kind: "done",
        outcome: {
          success: false,
          action,
          element,
          selectedElement,
          searchUntil,
          error: `Cannot focus ${describeFocusTarget(element, options)} because it is not an editable input`,
        },
      };
    }

    if (isElementKeyboardFocused(element)) {
      logger.info(`Element is already focused, no action needed`);
      return {
        kind: "done",
        outcome: withResolvedLayer(
          {
            success: true,
            action,
            element,
            selectedElement,
            searchUntil,
            wasAlreadyFocused: true,
            focusChanged: false,
            focusVerified: true,
            x: tapPoint.x,
            y: tapPoint.y,
          },
          resolvedElementLayer(viewHierarchy, element, this.host.platform),
        ),
      };
    }

    const matched = input.matchedElement;
    return { kind: "tap", labelText: matched && matched !== element ? matched.text : undefined };
  }
}
