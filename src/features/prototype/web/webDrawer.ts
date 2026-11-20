import {
  ABSOLUTE,
  ALIGN_ITEMS,
  BACKGROUND_COLOR,
  BOX_SHADOW,
  BOX_SIZING,
  BORDER_BOX,
  CENTER,
  COLUMN,
  DATA_PART,
  DATA_TESTID,
  FLEX,
  FLEX_DIRECTION,
  FLEX_SHRINK,
  JUSTIFY_CONTENT,
  RELATIVE,
} from "./webCss";
import type { Rgba } from "../prototypeContrast";
import type { Raw } from "../prototypeTemplate";
import { el } from "./webNodes";
import type { WebRenderKit, WebRenderScope } from "./webRender";
import {
  hoistedScope,
  LAYER_CSS,
  openLayer,
  roleColor,
  scrimCss,
  type WebLayerRenderer,
} from "./webSheet";
import { iosRole } from "./webSkinIos";
import { rgbaCss } from "./webStyle";
import { withOverContentLayers } from "./webStylePolish";

/** The drawer surface's tonal and shadow elevation, as Android's drawer `Surface` sets both. */
const DRAWER_ELEVATION_DP = 3;

/** The safe-drawing edges the drawer layer pads by, consumed for the drawer and its content. */
const DRAWER_INSETS: readonly string[] = ["top", "bottom", "start", "end"];

/**
 * Material 3's `surfaceColorAtElevation`: `surface` under the `surfaceTint` at
 * `(4.5 ln(elevation + 1) + 2) / 100`, which a `surface`-coloured `Surface` paints at a tonal
 * elevation.
 */
export function tonalSurface(scope: WebRenderScope, elevationDp: number): string {
  const surface = roleColor("surface", scope.style);
  const tint = roleColor("surfaceTint", scope.style);
  const alpha = (4.5 * Math.log(elevationDp + 1) + 2) / 100;
  const mix = (base: number, over: number) => Math.round(base + (over - base) * alpha);
  const blended: Rgba = {
    r: mix(surface.r, tint.r),
    g: mix(surface.g, tint.g),
    b: mix(surface.b, tint.b),
    a: surface.a,
  };
  return rgbaCss(blended);
}

/** A part's test tag, `<testTag>.<part>`, as the devices tag a drawer's close scrim. */
function partTag(node: Raw, part: string): Record<string, string> {
  return typeof node.testTag === "string" ? { [DATA_TESTID]: `${node.testTag}.${part}` } : {};
}

/**
 * The surface's own colour per skin: Android's `surface` at tonal elevation 3, the iOS renderer's
 * `surfaceContainerHigh` (else the secondary system background).
 */
function drawerSurface(scope: WebRenderScope): string {
  if (scope.skin === "ios") {
    const fallback = scope.style.mode === "dark" ? "rgba(28,28,30,1)" : "rgba(242,242,247,1)";
    return iosRole("surfaceContainerHigh", fallback, scope);
  }
  return tonalSurface(scope, DRAWER_ELEVATION_DP);
}

/**
 * Android's drawer: inside the safe-drawing insets, which it consumes, a scrim (the `scrim` slot,
 * else the default sheet scrim) and, at the `edge` (`end` unless `start`, mirrored in RTL) and
 * centred vertically, a full-height surface `min(320px, 100% - 56px)` wide in `surface` at tonal
 * elevation 3 with a 3 dp shadow, holding its child in a column from the leading edge. Authored
 * style applies to the surface, sized against the row it sits in, and wins.
 */
function drawerLayer(node: Raw, scope: WebRenderScope, path: string, kit: WebRenderKit) {
  const hoisted = { ...hoistedScope(scope), consumedInsets: DRAWER_INSETS };
  const inRow = { ...hoisted, style: { ...hoisted.style, parentAxis: "row" as const } };
  const { attrs, style: base } = kit.base(node, inRow, {
    display: FLEX,
    [FLEX_DIRECTION]: COLUMN,
    [ALIGN_ITEMS]: "flex-start",
    position: RELATIVE,
    [BOX_SIZING]: BORDER_BOX,
    width: "max(0px, min(320px, calc(100% - 56px)))",
    height: "100%",
    [FLEX_SHRINK]: "0",
    [BOX_SHADOW]: "0 1.5px 3px rgba(0,0,0,0.25)",
  });
  const style = base[BACKGROUND_COLOR]
    ? base
    : { ...base, [BACKGROUND_COLOR]: drawerSurface(scope) };
  const inner = kit.child(hoisted, {
    style: { ...hoisted.style, parentAxis: COLUMN, weightsChildren: false },
  });
  const content = kit.renderNode(node.child, inner, `${path}.child`);
  const scrim = el("div", {
    attrs: { [DATA_PART]: "scrim", ...partTag(node, "close") },
    style: {
      position: ABSOLUTE,
      inset: "0",
      [BACKGROUND_COLOR]: scrimCss(node.scrim, scope.style),
    },
  });
  const surface = withOverContentLayers(
    el("div", { attrs: { ...attrs, [DATA_PART]: "drawer" }, style }, content ? [content] : []),
    node.style,
    scope.style,
  );
  // A row in the window's direction, so `start` and `end` mirror in RTL.
  const frame = {
    display: FLEX,
    [FLEX_DIRECTION]: "row",
    [ALIGN_ITEMS]: CENTER,
    [JUSTIFY_CONTENT]: node.edge === "start" ? "flex-start" : "flex-end",
  };
  return el(
    "div",
    {
      attrs: { [DATA_PART]: "drawerLayer" },
      style: {
        ...LAYER_CSS,
        [BOX_SIZING]: BORDER_BOX,
        padding:
          "var(--safe-top, 0px) var(--safe-right, 0px) var(--safe-bottom, 0px) var(--safe-left, 0px)",
      },
    },
    [
      // The scrim sits inside the insets, as Android pads the whole drawer box by them.
      el(
        "div",
        {
          attrs: { [DATA_PART]: "drawerFrame" },
          style: { ...frame, position: RELATIVE, width: "100%", height: "100%" },
        },
        [scrim, surface],
      ),
    ],
  );
}

export function webDrawerLayers(kit: WebRenderKit): Readonly<Record<string, WebLayerRenderer>> {
  return { drawer: openLayer((node, scope, path) => drawerLayer(node, scope, path, kit)) };
}
