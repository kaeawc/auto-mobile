import { buildObserveResult } from "../../helpers/observeFixture";
import type { ObserveResult, ViewHierarchyNode } from "../../../src/models";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { iosKeyboardVisibleHierarchy } from "../../fixtures/observe/iosKeyboardStates";

/** A readable screen with no editable target, optionally showing its software keyboard. */
export function unfocusedObservation(keyboardVisible = false): ObserveResult {
  return buildObserveResult({
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    updatedAt: 1,
    viewHierarchy: {
      hierarchy: {
        node: {
          $: { class: "UIView" },
          node: [
            { $: { class: "UIButton", label: "Continue" } },
            ...(keyboardVisible
              ? [{ $: { class: "UIKeyboard", bounds: "[0,1200][1080,1920]" } }]
              : []),
          ],
        },
      },
    },
  });
}

/** A native input that contributes a verification snapshot but has no typing focus. */
export function unfocusedNativeInputObservation(): ObserveResult {
  return buildObserveResult({
    ...unfocusedObservation(),
    viewHierarchy: {
      hierarchy: {
        node: {
          $: { class: "UITextField", "view-id": "email", focused: "false", value: "" },
        },
      },
    },
  });
}

export function typedObservation(value: string, secure = false, omitValue = false): ObserveResult {
  const hierarchy = structuredClone(iosKeyboardVisibleHierarchy);
  const parser = new DefaultElementParser();
  for (const root of parser.extractRootNodes(hierarchy)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const attributes = nodeAttributes(node);
      if (attributes.focused === "true" && attributes["hint-text"] === "Email") {
        if (omitValue) {
          delete attributes.value;
        } else {
          attributes.value = value;
        }
        attributes.password = secure;
        if (secure) {
          Object.defineProperty(attributes, "value", {
            get() {
              throw new Error("Secure value read");
            },
          });
        }
      }
    });
  }
  return buildObserveResult({
    screenSize: { width: 1080, height: 1920 },
    systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    updatedAt: 1,
    viewHierarchy: hierarchy,
  });
}
