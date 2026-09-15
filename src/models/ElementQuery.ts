import type { Element } from "./Element";
import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";
import type { ViewHierarchyNode } from "./ViewHierarchyResult";

/** One selector at each level; `container` names a strict ancestor. */
export interface ElementQuery {
  elementId?: string;
  text?: string;
  testTag?: string;
  container?: ElementQuery;
  /** Zero-based occurrence within this level's candidate set. */
  index?: number;
  selectionStrategy?: ElementSelectionStrategy;
}

export interface QueryLevel {
  selector: Omit<ElementQuery, "container">;
  matchCount: number;
  selectedIndex: number;
  element: Partial<Element>;
}

export interface QueryDiagnostic {
  code:
    | "container_not_found"
    | "container_ambiguous"
    | "target_not_found"
    | "target_ambiguous"
    | "index_out_of_range"
    | "target_not_actionable";
  /** Zero-based level, starting at the outermost container. */
  level: number;
  matchCount: number;
  candidates: Partial<Element>[];
}

export interface ElementQueryResult {
  node: ViewHierarchyNode | null;
  element: Element | null;
  levels: QueryLevel[];
  /** Internal capture nodes, never included in discovery metadata. */
  scopeNodes?: ViewHierarchyNode[];
  diagnostic?: QueryDiagnostic;
}
