import { ElementBounds } from "./ElementBounds";
import type { SemanticLink } from "./SemanticLink";

/**
 * Represents a UI element with its properties
 */
export interface Element {
  bounds: ElementBounds;
  text?: string;
  "content-desc"?: string;
  "resource-id"?: string;
  "view-id"?: string;
  "class"?: string;
  "package"?: string;
  checkable?: boolean | string;
  checked?: boolean | string;
  clickable?: boolean | string;
  enabled?: boolean | string;
  focusable?: boolean | string;
  focused?: boolean | string;
  "accessibility-focused"?: boolean | string;
  scrollable?: boolean | string;
  orientation?: string;
  selected?: boolean | string;
  "semantic-links"?: SemanticLink[];
  /** Hierarchy depth injected during exploration element extraction */
  hierarchyDepth?: number;
  /** Child nodes from XML parsing (e.g., Compose UI elements) */
  node?: Record<string, unknown> | Record<string, unknown>[];
  [key: string]: any;
}

/**
 * Check if a boolean-or-string value is truthy.
 * Handles both native booleans and string values from XML parsing.
 */
export function isTruthy(value: boolean | string | undefined): boolean {
  return value === true || value === "true";
}

/**
 * Check if a boolean-or-string value is falsy (explicitly false).
 * Returns true only when the value is explicitly false or "false".
 */
export function isFalsy(value: boolean | string | undefined): boolean {
  return value === false || value === "false";
}
