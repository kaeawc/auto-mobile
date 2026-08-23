/**
 * An activatable accessibility link embedded in an observed text element.
 * `occurrence` is zero-based among matching visible link texts in that element.
 */
export interface SemanticLink {
  text: string;
  occurrence: number;
  start?: number;
  end?: number;
}
