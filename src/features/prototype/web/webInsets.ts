import { record, type Raw } from "../prototypeTemplate";
import type { WebRenderScope } from "./webRender";

const SAFE_AREA_EDGES: Readonly<Record<string, [string, string]>> = {
  top: ["padding-top", "--safe-top"],
  bottom: ["padding-bottom", "--safe-bottom"],
  // Logical edges read logical insets, which the window maps to the physical side for its direction.
  start: ["padding-inline-start", "--safe-start"],
  end: ["padding-inline-end", "--safe-end"],
};

/**
 * `safeAreaPadding` adds the frame's inset on each named edge to the node's own padding. System
 * bars and the cutout both read the frame's safe area; the still has no keyboard, so `ime` adds
 * nothing.
 */
/** The edges a node's safeAreaPadding takes from the frame (none for `ime` alone). */
export function safeAreaEdges(node: Raw): string[] {
  const safe = record(node.safeAreaPadding);
  const types = Array.isArray(safe?.types) ? safe.types : [];
  if (!safe || !Array.isArray(safe.edges) || !types.some((type) => type !== "ime")) {
    return [];
  }
  return safe.edges.map(String).filter((edge) => SAFE_AREA_EDGES[edge] !== undefined);
}

/** Expands a `padding` shorthand of px values into logical longhands; others stay as they are. */
function paddingLonghands(css: Record<string, string>): Record<string, string> {
  const shorthand = css.padding;
  if (shorthand === undefined) {
    return { ...css };
  }
  const parts = shorthand.trim().split(/\s+/);
  const [top, end = top, bottom = top, start = end] = parts;
  const rest = Object.fromEntries(Object.entries(css).filter(([key]) => key !== "padding"));
  return {
    "padding-top": top!,
    "padding-inline-end": end!,
    "padding-bottom": bottom!,
    "padding-inline-start": start!,
    ...rest,
  };
}

/**
 * Like windowInsetsPadding, an inset an ancestor already applied is consumed, so a descendant
 * asking for the same edge adds nothing more.
 */
export function safeAreaCss(
  node: Raw,
  scope: WebRenderScope,
  css: Record<string, string>,
): Record<string, string> {
  const consumed = scope.consumedInsets ?? [];
  // A component's `padding` shorthand becomes longhands first, so an inset adds to it rather than
  // replacing it on that edge.
  const padded = safeAreaEdges(node).length > 0 ? paddingLonghands(css) : { ...css };
  for (const edge of safeAreaEdges(node)) {
    const target = SAFE_AREA_EDGES[edge];
    if (target && !consumed.includes(edge)) {
      padded[target[0]] = `calc(${padded[target[0]] ?? "0px"} + var(${target[1]}))`;
    }
  }
  return padded;
}
