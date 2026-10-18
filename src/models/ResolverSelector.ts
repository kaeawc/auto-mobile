import type { ElementSelectionStrategy } from "./ElementSelectionStrategy";

/** Canonical resolver selector. Tools compose this schema as they migrate. */
export interface ResolverSelector {
  elementId?: string;
  text?: string;
  testTag?: string;
  contentDescription?: string;
  className?: string;
  index?: number;
  selectionStrategy?: ElementSelectionStrategy;
  match?: "exact" | "contains" | "regex";
  caseSensitive?: boolean;
  container?: ResolverSelector;
  sibling?: ResolverSelector;
}
