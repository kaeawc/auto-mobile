import type { ObserveResult, ViewHierarchyNode } from "../../../src/models";
import { nodeAttributes } from "../../../src/models/ViewHierarchyResult";
import { DefaultElementParser } from "../../../src/features/utility/ElementParser";
import { iosKeyboardVisibleHierarchy } from "../../fixtures/observe/iosKeyboardStates";

export function typedObservation(value: string, secure = false): ObserveResult {
  const hierarchy = structuredClone(iosKeyboardVisibleHierarchy);
  const parser = new DefaultElementParser();
  for (const root of parser.extractRootNodes(hierarchy)) {
    parser.traverseNode(root, (node: ViewHierarchyNode) => {
      const attributes = nodeAttributes(node);
      if (attributes.focused === "true" && attributes["hint-text"] === "Email") {
        attributes.value = value;
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
  return { timestamp: 1, viewHierarchy: hierarchy } as ObserveResult;
}
