import type { ObserveResult, ViewHierarchyResult } from "../../models";
import type { ElementParser } from "../../utils/interfaces/ElementParser";

/**
 * Metadata describing what a long-press appeared to trigger, derived purely
 * from comparing the view hierarchy before and after the gesture.
 */
export interface LongPressMetadata {
  /** A context menu, text selection, or new window was observed. */
  pressRecognized: boolean;
  /** A new root containing menu/popup indicators appeared. */
  contextMenuOpened: boolean;
  /** A text-selection range (start < end) became active. */
  selectionStarted: boolean;
}

/**
 * Pure analyser that classifies the outcome of a long-press by diffing the
 * pre- and post-gesture view hierarchies.
 *
 * Extracted from `TapOnElement` so this hierarchy-walking logic is a small,
 * `ElementParser`-only collaborator that can be unit-tested in isolation with
 * the existing fake/parser conventions, instead of being reachable only
 * through a full `execute()` flow.
 */
export class LongPressMetadataDetector {
  constructor(private readonly elementParser: ElementParser) {}

  detect(
    previousObservation: ObserveResult | null,
    currentObservation?: ObserveResult,
  ): LongPressMetadata {
    const previousHierarchy = previousObservation?.viewHierarchy;
    const currentHierarchy = currentObservation?.viewHierarchy;
    const contextMenuOpened = this.detectContextMenuOpened(previousHierarchy, currentHierarchy);
    const selectionStarted = this.detectSelectionStarted(currentHierarchy);
    const windowChange = this.detectNewWindow(previousHierarchy, currentHierarchy);

    return {
      pressRecognized: contextMenuOpened || selectionStarted || windowChange,
      contextMenuOpened,
      selectionStarted,
    };
  }

  private detectContextMenuOpened(
    previousHierarchy?: ViewHierarchyResult,
    currentHierarchy?: ViewHierarchyResult,
  ): boolean {
    if (!currentHierarchy) {
      return false;
    }
    const previousRoots = this.getRootSignatures(previousHierarchy);
    const currentRoots = this.elementParser.extractRootNodes(currentHierarchy);

    for (const root of currentRoots) {
      const signature = this.getRootSignature(root);
      if (previousRoots.has(signature)) {
        continue;
      }
      if (this.containsMenuIndicators(root)) {
        return true;
      }
    }

    return false;
  }

  private detectNewWindow(
    previousHierarchy?: ViewHierarchyResult,
    currentHierarchy?: ViewHierarchyResult,
  ): boolean {
    if (!currentHierarchy) {
      return false;
    }
    const previousRoots = this.getRootSignatures(previousHierarchy);
    const currentRoots = this.elementParser.extractRootNodes(currentHierarchy);
    if (currentRoots.length === 0) {
      return false;
    }

    return currentRoots.some((root) => !previousRoots.has(this.getRootSignature(root)));
  }

  private detectSelectionStarted(currentHierarchy?: ViewHierarchyResult): boolean {
    if (!currentHierarchy) {
      return false;
    }

    const roots = this.elementParser.extractRootNodes(currentHierarchy);
    let selectionFound = false;
    const selectionKeyPairs: Array<[string, string]> = [
      ["textSelectionStart", "textSelectionEnd"],
      ["selectionStart", "selectionEnd"],
    ];

    for (const root of roots) {
      this.elementParser.traverseNode(root, (node: any) => {
        if (selectionFound) {
          return;
        }
        const props = this.elementParser.extractNodeProperties(node);
        for (const [startKey, endKey] of selectionKeyPairs) {
          const startValue = props?.[startKey] ?? props?.[startKey.toLowerCase()];
          const endValue = props?.[endKey] ?? props?.[endKey.toLowerCase()];
          if (startValue === undefined || endValue === undefined) {
            continue;
          }
          const startNumeric =
            typeof startValue === "string" ? parseInt(startValue, 10) : Number(startValue);
          const endNumeric =
            typeof endValue === "string" ? parseInt(endValue, 10) : Number(endValue);
          if (
            !Number.isNaN(startNumeric) &&
            !Number.isNaN(endNumeric) &&
            endNumeric > startNumeric
          ) {
            selectionFound = true;
            return;
          }
        }
      });
      if (selectionFound) {
        break;
      }
    }

    return selectionFound;
  }

  private getRootSignatures(viewHierarchy?: ViewHierarchyResult): Set<string> {
    if (!viewHierarchy) {
      return new Set();
    }
    const roots = this.elementParser.extractRootNodes(viewHierarchy);
    return new Set(roots.map((root) => this.getRootSignature(root)));
  }

  private getRootSignature(root: any): string {
    const props = this.elementParser.extractNodeProperties(root);
    const resourceId = props["resource-id"] ?? props.resourceId ?? "";
    const className = props.class ?? props.className ?? "";
    const bounds = props.bounds ?? "";
    const text = props.text ?? props["content-desc"] ?? "";
    return `${resourceId}|${className}|${bounds}|${text}`;
  }

  private containsMenuIndicators(root: any): boolean {
    let found = false;
    this.elementParser.traverseNode(root, (node: any) => {
      if (found) {
        return;
      }
      const props = this.elementParser.extractNodeProperties(node);
      const resourceId = (props["resource-id"] ?? props.resourceId ?? "").toLowerCase();
      const className = (props.class ?? props.className ?? "").toLowerCase();
      const text = (props.text ?? props["content-desc"] ?? "").toLowerCase();
      if (
        resourceId.includes("menu") ||
        resourceId.includes("popup") ||
        className.includes("menu") ||
        className.includes("popup") ||
        text.includes("menu") ||
        text.includes("popup")
      ) {
        found = true;
      }
    });
    return found;
  }
}
