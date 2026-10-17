/**
 * What `ElementSelector.select` looks for: the field subset of the resolver's canonical selector
 * that a caller holding a view hierarchy needs, so the interface layer does not depend on the
 * server schemas. A `ResolverSelector` is assignable to it.
 */
export interface ElementQuery {
  elementId?: string;
  text?: string;
  testTag?: string;
  contentDescription?: string;
  className?: string;
  match?: "exact" | "contains" | "regex";
  /** The element must share a parent with a clickable that this nested query names. */
  sibling?: ElementQuery;
}
