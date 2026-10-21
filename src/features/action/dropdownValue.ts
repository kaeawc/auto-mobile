import type { Element } from "../../models/Element";
import type { ViewHierarchyNode } from "../../models/ViewHierarchyResult";
import { getHierarchyNodeSource } from "../observe/output/elementProvenance";
import { DefaultElementParser } from "../utility/ElementParser";
import { toSearchable } from "../utility/SearchableNode";

/**
 * The value a dropdown shows through its descendants: the first descendant text, else the first
 * descendant content-desc. Resolved elements are flat, and a framework Spinner keeps its selection
 * in a child TextView (`android:id/text1`), so this walks the element's hierarchy source (#14657).
 */
export function readDropdownDescendantValue(element: Element): string | undefined {
  const source = getHierarchyNodeSource(element);
  if (!source) {
    return undefined;
  }
  const parser = new DefaultElementParser();
  let textValue: string | undefined;
  let descriptionValue: string | undefined;
  parser.traverseNode(source, (node: ViewHierarchyNode, depth) => {
    if (depth === 0) {
      return;
    }
    const searchable = toSearchable(parser.extractNodeProperties(node));
    textValue ??= searchable.textSources.text;
    descriptionValue ??= searchable.textSources["content-desc"];
  });
  return textValue ?? descriptionValue;
}
