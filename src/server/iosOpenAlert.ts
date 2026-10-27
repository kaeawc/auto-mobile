import { ActionableError } from "../models/ActionableError";
import { nodeAttributes } from "../models/ViewHierarchyResult";
import type { ObserveResult } from "../models";

export type IosOpenAlertPhase = "detect" | "tap" | "verify";

/**
 * Structured failure for `openLink` `acceptOpenAlert` on iOS. `phase` says which step failed so
 * a caller can tell "the alert had nothing to accept" (detect) from "the tap had no effect"
 * (tap, verify); `candidates` lists the accept-button labels the hierarchy offered.
 */
export class IosOpenAlertError extends ActionableError {
  constructor(
    readonly phase: IosOpenAlertPhase,
    reason: string,
    readonly candidates: readonly string[] = [],
  ) {
    super(
      `Failed to accept iOS app-open alert: ${reason} (phase: ${phase}${
        candidates.length > 0 ? `, buttons: ${candidates.join(", ")}` : ""
      })`,
    );
  }
}

export interface IosOpenAlertAcceptButton {
  /** Exact selector fields for the tap, taken from the hierarchy node (never a fixed English label). */
  selector: { elementId: string } | { text: string };
  /** Display labels of every button-like node found in the alert, in accessibility order. */
  candidates: string[];
}

type Node = Record<string, unknown>;

const ALERT_CLASSES = new Set([
  "UIAlertController",
  "UIActionSheet",
  "XCUIElementTypeAlert",
  "XCUIElementTypeSheet",
]);

const OPEN_IN_PROMPT = /^open in .+\?$/i;

function attr(node: Node, key: string): unknown {
  return node[key] ?? nodeAttributes(node)[key];
}

function str(node: Node, ...keys: string[]): string | undefined {
  for (const key of keys) {
    const value = attr(node, key);
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}

function children(node: Node): Node[] {
  return Object.entries(node).flatMap(([key, child]) => {
    if (key === "$") {
      return [];
    }
    return (Array.isArray(child) ? child : [child]).filter(
      (item): item is Node => !!item && typeof item === "object",
    );
  });
}

function descendants(node: Node): Node[] {
  return children(node).flatMap((child) => [child, ...descendants(child)]);
}

function label(node: Node): string | undefined {
  return str(node, "text", "label", "content-desc", "contentDescription", "resource-id");
}

function isButtonLike(node: Node): boolean {
  const className = attr(node, "className") ?? attr(node, "class");
  return (
    className === "UIButton" ||
    attr(node, "role") === "button" ||
    attr(node, "clickable") === true ||
    attr(node, "clickable") === "true"
  );
}

function isAlertMarker(node: Node): boolean {
  const className = attr(node, "className") ?? attr(node, "class");
  if (typeof className === "string" && ALERT_CLASSES.has(className)) {
    return true;
  }
  const own = str(node, "text", "label", "content-desc", "contentDescription");
  return own !== undefined && OPEN_IN_PROMPT.test(own);
}

/** Buttons under an alert marker, or under its parent when the prompt label is a sibling of them. */
function findAlertButtons(node: Node, ancestors: readonly Node[] = []): Node[] | null {
  if (isAlertMarker(node)) {
    for (const scope of [node, ancestors.at(-1)]) {
      if (!scope) {
        continue;
      }
      const buttons = descendants(scope).filter(isButtonLike);
      if (buttons.length > 0) {
        return buttons;
      }
    }
  }
  for (const child of children(node)) {
    const found = findAlertButtons(child, [...ancestors, node]);
    if (found) {
      return found;
    }
  }
  return null;
}

/**
 * Pick the accept action of the system "Open in <App>?" confirmation by role and position, not
 * by its localized label: the alert's button-like nodes in accessibility order, where the
 * default (non-cancel) action is the last. Returns null when the hierarchy holds no alert or
 * the alert offers no button-like node.
 */
export function selectIosOpenAlertAcceptButton(
  hierarchy: ObserveResult["viewHierarchy"] | undefined,
): IosOpenAlertAcceptButton | null {
  const root = hierarchy?.hierarchy;
  if (!root || typeof root !== "object") {
    return null;
  }
  const buttons = findAlertButtons(root as Node);
  const accept = buttons?.at(-1);
  const acceptLabel = accept ? label(accept) : undefined;
  if (!accept || acceptLabel === undefined) {
    return null;
  }
  const elementId = str(accept, "resource-id", "identifier");
  return {
    selector: elementId ? { elementId } : { text: acceptLabel },
    candidates: (buttons ?? []).flatMap((button) => label(button) ?? []),
  };
}
