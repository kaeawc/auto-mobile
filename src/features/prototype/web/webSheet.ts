import { prototypeRolePalette, type Rgba } from "../prototypeContrast";
import { record, type Raw } from "../prototypeTemplate";
import { el, type WebElement } from "./webNodes";
import type { WebRenderKit, WebRenderScope } from "./webRender";
import { cssColor, rgbaCss, type WebStyleContext } from "./webStyle";
import { shaderFallback, withOverContentLayers } from "./webStylePolish";

/**
 * A node drawn in the window's layer above the whole tree instead of in place. It appends what it
 * draws to `scope.layers` and leaves nothing in its parent.
 */
export type WebLayerRenderer = (node: Raw, scope: WebRenderScope, path: string) => void;

/** The default scrim opacity of the `scrim` role, as both devices draw it (0.4). */
const SCRIM_ROLE_ALPHA = 0.4;

/** A layer covers its window: the still's window element is its positioned ancestor. */
export const LAYER_CSS: Readonly<Record<string, string>> = {
  position: "absolute",
  inset: "0",
  display: "flex",
  "flex-direction": "column",
  "justify-content": "flex-end",
};

/** A role from the palette, else the Material 3 baseline when a derived scheme leaves it out. */
export function roleColor(role: string, style: WebStyleContext): Rgba {
  return style.palette.get(role) ?? prototypeRolePalette({}, style.mode).get(role)!;
}

/**
 * A scrim slot as both devices resolve it: the `scrim` role (the default, alone or as the mode's
 * side of a pair) at the default scrim opacity, any other role or hex exactly. A value the still
 * cannot resolve draws the default scrim, as Android falls back to it.
 */
function scrimCss(value: unknown, style: WebStyleContext): string {
  const token = record(value)?.[style.mode] ?? value ?? "scrim";
  const dim = rgbaCss({ ...roleColor("scrim", style), a: SCRIM_ROLE_ALPHA });
  return token === "scrim" ? dim : (cssColor(token, style) ?? dim);
}

/** The first detent's height in the window: half, all, or a fixed size never above the window. */
function detentHeight(detents: unknown): string {
  const first = Array.isArray(detents) ? detents[0] : undefined;
  if (first === "full") {
    return "100%";
  }
  const dp = record(first)?.dp;
  return typeof dp === "number" ? `min(${Number(dp.toFixed(3))}px, 100%)` : "50%";
}

/** Whether the sheet's `openWhen` key holds exactly its boolean `equals`; a missing key does not. */
export function sheetOpen(node: Raw, scope: WebRenderScope): boolean {
  const when = record(node.openWhen);
  if (typeof when?.key !== "string" || typeof when.equals !== "boolean") {
    return false;
  }
  return scope.condition.state[when.key] === when.equals;
}

/** Drawn at the window, not in its parent: no grid cell, and no inset an ancestor consumed. */
export function hoistedScope(scope: WebRenderScope): WebRenderScope {
  return {
    ...scope,
    inBox: false,
    consumedInsets: [],
    style: { ...scope.style, parentAxis: "column", weightsChildren: false },
  };
}

/**
 * An open-by-state layer: nothing while closed, else the drawn layer at the position it held
 * before its own subtree drew, so layers keep tree order, an outer layer before any inside it.
 */
export function openLayer(
  draw: (node: Raw, scope: WebRenderScope, path: string) => WebElement,
): WebLayerRenderer {
  return (node, scope, path) => {
    if (!sheetOpen(node, scope)) {
      return;
    }
    // A closed layer draws nothing; an open one draws without its shader, so it is listed.
    const shaded = shaderFallback(node, path);
    if (shaded) {
      scope.unsupported.push(shaded);
    }
    const at = scope.layers.length;
    const layer = draw(node, scope, path);
    scope.layers.splice(at, 0, layer);
  };
}

/** Android's drag handle: a 32x4 `onSurfaceVariant` bar with 8 px around it, centred. */
function dragHandle(style: WebStyleContext): WebElement {
  return el("div", {
    attrs: { "data-part": "handle" },
    style: {
      width: "32px",
      height: "4px",
      margin: "8px",
      "border-radius": "2px",
      "align-self": "center",
      "flex-shrink": "0",
      "background-color": rgbaCss(roleColor("onSurfaceVariant", style)),
    },
  });
}

/**
 * Android's in-window sheet: a scrim over the window and, at its bottom, a full-width column as
 * tall as the first detent, painted `surface` unless an authored background resolves. The
 * handle comes first, then the child. Authored style applies to the sheet and wins.
 */
function sheetLayer(node: Raw, scope: WebRenderScope, path: string, kit: WebRenderKit) {
  const hoisted = hoistedScope(scope);
  const { attrs, style: base } = kit.base(node, hoisted, {
    display: "flex",
    "flex-direction": "column",
    "align-items": "flex-start",
    position: "relative",
    width: "100%",
    height: detentHeight(node.detents),
    "max-height": "100%",
    "flex-shrink": "0",
  });
  // An authored background that resolves paints the sheet; otherwise (none, or an unresolved
  // colour) it keeps the `surface` the devices fall back to, under any authored gradient.
  const style = base["background-color"]
    ? base
    : { ...base, "background-color": rgbaCss(roleColor("surface", scope.style)) };
  const inner = kit.child(hoisted, {
    style: { ...hoisted.style, parentAxis: "column", weightsChildren: false },
  });
  const content = kit.renderNode(node.child, inner, `${path}.child`);
  const scrim = el("div", {
    attrs: { "data-part": "scrim" },
    style: {
      position: "absolute",
      inset: "0",
      "background-color": scrimCss(node.scrim, scope.style),
    },
  });
  // A gradient border and inner shadows paint over the sheet's content, as on any other node.
  const sheet = withOverContentLayers(
    el("div", { attrs: { ...attrs, "data-part": "sheet" }, style }, [
      ...(node.dragHandle === false ? [] : [dragHandle(scope.style)]),
      ...(content ? [content] : []),
    ]),
    node.style,
    scope.style,
  );
  return el("div", { attrs: { "data-part": "sheetLayer" }, style: { ...LAYER_CSS } }, [
    scrim,
    sheet,
  ]);
}

/** Node types the renderer hoists into a window layer, leaving nothing in their parent's flow. */
export const WEB_LAYER_TYPES: ReadonlySet<string> = new Set(["bottomSheet", "dialog", "snackbar"]);

/** Whether a node is hoisted into a window layer (see WEB_LAYER_TYPES), open or closed. */
export function isWebLayerNode(node: Raw | undefined): boolean {
  return node !== undefined && WEB_LAYER_TYPES.has(String(node.type));
}

export function webSheetLayers(kit: WebRenderKit): Readonly<Record<string, WebLayerRenderer>> {
  // Layers keep tree order, a sheet before any sheet inside it, as both devices stack them.
  const bottomSheet = openLayer((node, scope, path) => sheetLayer(node, scope, path, kit));
  return { bottomSheet };
}
