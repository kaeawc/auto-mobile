import { BACKGROUND_COLOR, BORDER_RADIUS } from "./webCss";
import type { Raw } from "../prototypeTemplate";
import type { WebRenderScope } from "./webRender";
import { cssColor } from "./webStyle";

/** CSS a parent's layout reads from its child: size, flex share, cross-axis alignment, grid cell. */
const PARENT_FACING = new Set([
  "width",
  "height",
  "flex",
  "flex-shrink",
  "align-self",
  "grid-area",
  "min-width",
  "max-width",
  "margin",
]);

export function splitParentFacing(
  style: Record<string, string>,
): [Record<string, string>, Record<string, string>] {
  const outer: Record<string, string> = {};
  const inner: Record<string, string> = {};
  for (const [key, value] of Object.entries(style)) {
    (PARENT_FACING.has(key) ? outer : inner)[key] = value;
  }
  return [outer, inner];
}

/**
 * Material text-field chrome. `filled` (the native default) is a tinted container with a bottom
 * indicator; `outlined` is a full outline. Either turns to the error colour on a decidable error.
 */
export function fieldChrome(
  node: Raw,
  error: boolean,
  scope: WebRenderScope,
): Record<string, string> {
  if (node.variant === "outlined") {
    const outline = cssColor(error ? "error" : "outline", scope.style) ?? "currentColor";
    return { [BORDER_RADIUS]: "4px", border: `1px solid ${outline}` };
  }
  const indicator = cssColor(error ? "error" : "onSurfaceVariant", scope.style) ?? "currentColor";
  const container = cssColor("surfaceContainerHighest", scope.style);
  return {
    [BORDER_RADIUS]: "4px 4px 0 0",
    "border-bottom": `1px solid ${indicator}`,
    ...(container ? { [BACKGROUND_COLOR]: container } : {}),
  };
}
