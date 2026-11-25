import {
  ABSOLUTE,
  ALIGN_ITEMS,
  BACKGROUND_COLOR,
  BORDER_BOX,
  BORDER_RADIUS,
  BOX_SHADOW,
  BOX_SIZING,
  CENTER,
  COLUMN,
  DATA_PART,
  DATA_TESTID,
  FLEX,
  FLEX_DIRECTION,
  FLEX_SHRINK,
  MAX_WIDTH,
  MIN_HEIGHT,
  MIN_WIDTH,
  POINTER_EVENTS,
  WHITE_SPACE,
} from "./webCss";
import { record, type Raw } from "../prototypeTemplate";
import { tonalSurface } from "./webDrawer";
import { el, type WebElement } from "./webNodes";
import type { WebRenderKit, WebRenderScope } from "./webRender";
import { hoistedScope, openLayer, roleColor, scrimCss, type WebLayerRenderer } from "./webSheet";
import { rgbaCss, textCss } from "./webStyle";
import { withOverContentLayers } from "./webStylePolish";

/**
 * Menus and tooltips (#16536) anchor to a node the still drew elsewhere in the window: a menu to
 * its parent's bottom-end, as Android places it, and a tooltip to the node its `anchorTo` names.
 * The still cannot measure, so the anchored node carries a CSS `anchor-name` and the layer places
 * its surface with CSS anchor positioning. A layer is a `display: contents` wrapper, so the
 * surface's containing block stays the window, which holds the anchor.
 */

type Css = Record<string, string>;

/**
 * Page rules a menu's anchored placement needs, which inline styles cannot hold: the fallback
 * that clamps a menu fitting neither below nor above its parent to the window's bottom edge, as
 * Android clamps the menu into the window. The page and the library's shadow root both add it.
 */
export const ANCHORED_LAYERS_PAGE_CSS = "@position-try --pa-menu-clamp{top:auto;bottom:0}";

/**
 * A dashed ident for `anchor-name`: the key's 32-bit FNV-1a hash, so a long path or any id makes a
 * short, valid name; the same key always makes the same name.
 */
export function webAnchorName(kind: "menu" | "id", key: string): string {
  let hash = 0x811c9dc5;
  for (const char of key) {
    hash = Math.imul(hash ^ char.codePointAt(0)!, 0x01000193) >>> 0;
  }
  return `--pa-${kind}-${hash.toString(16).padStart(8, "0")}`;
}

/** The path of the node a menu at `path` anchors to: its parent, as Android anchors menus. */
export const webMenuParentPath = (path: string): string => path.replace(/\.children\[\d+\]$/, "");

/** The anchor names a node carries: its path's when a child is a menu, its id's when a tooltip names it. */
export function webAnchorNames(node: Raw, path: string, scope: WebRenderScope): string[] {
  const children = Array.isArray(node.children) ? node.children : [];
  const menuParent = children.some((entry) => record(entry)?.type === "menu");
  const target = typeof node.id === "string" && scope.anchorTargets?.has(node.id) === true;
  return [
    ...(menuParent ? [webAnchorName("menu", path)] : []),
    ...(target ? [webAnchorName("id", node.id as string)] : []),
  ];
}

const role = (name: string, scope: WebRenderScope): string => rgbaCss(roleColor(name, scope.style));

/** A part's test tag, `<testTag>.<part>`, as the devices tag a menu's rows. */
function partTag(node: Raw, part: string): Record<string, string> {
  return typeof node.testTag === "string" ? { [DATA_TESTID]: `${node.testTag}.${part}` } : {};
}

/** What a menu's rows read: the menu node, its hoisted scope and the shared drawing helpers. */
interface MenuContext {
  readonly node: Raw;
  readonly scope: WebRenderScope;
  readonly kit: WebRenderKit;
}

/** A layer that adds nothing of its own to the layout: its positioned parts place in the window. */
const CONTENTS_LAYER: Css = { display: "contents" };

/**
 * One menu row: at least 48 px tall with 16 px either side and 12 px between the optional icon,
 * the label and the trailing text, at 0.38 when disabled.
 */
function menuRow(item: Raw, index: number, { node, scope, kit }: MenuContext) {
  const icon =
    typeof item.icon === "string" ? [kit.icon({ type: "icon", name: item.icon }, scope, "")] : [];
  const trailing =
    typeof item.trailingText === "string"
      ? [el("span", { attrs: { [DATA_PART]: "trailing" } }, [kit.bound(item.trailingText, scope)])]
      : [];
  return el(
    "div",
    {
      attrs: { role: "menuitem", [DATA_PART]: "item", ...partTag(node, String(index)) },
      style: {
        display: FLEX,
        [ALIGN_ITEMS]: CENTER,
        gap: "12px",
        [MIN_HEIGHT]: "48px",
        padding: "0 16px",
        ...(item.enabled === false ? { opacity: "0.38" } : {}),
      },
    },
    [
      ...icon,
      el(
        "span",
        { attrs: { [DATA_PART]: "label" }, style: { flex: "1 1 auto", [WHITE_SPACE]: "pre-wrap" } },
        [kit.bound(item.label, scope)],
      ),
      ...trailing,
    ],
  );
}

/** A divider row: a 1 px `outlineVariant` line across the menu. */
const menuDivider = (scope: WebRenderScope) =>
  el("div", {
    attrs: { role: "separator", [DATA_PART]: "divider" },
    style: { height: "1px", [BACKGROUND_COLOR]: role("outlineVariant", scope), [FLEX_SHRINK]: "0" },
  });

/** The menu surface per skin: Android's tonal Material menu, the iOS renderer's raised panel. */
function menuSurfaceCss(scope: WebRenderScope): Css {
  if (scope.skin === "ios") {
    return {
      width: "min(280px, 100%)",
      [BACKGROUND_COLOR]: role("surfaceContainerHigh", scope),
      [BORDER_RADIUS]: "8px",
      [BOX_SHADOW]: "0 0 3px rgba(0,0,0,0.2)",
    };
  }
  return {
    [MIN_WIDTH]: "112px",
    [MAX_WIDTH]: "min(320px, 100%)",
    [BACKGROUND_COLOR]: tonalSurface(scope, 3),
    [BORDER_RADIUS]: "4px",
    [BOX_SHADOW]: "0 1.5px 3px rgba(0,0,0,0.25)",
  };
}

/**
 * A menu drawn open: below its parent with their end edges aligned, as Android places it, above
 * when it does not fit below (`flip-block`), else at the window's bottom (ANCHORED_LAYERS_PAGE_CSS),
 * as Android clamps it into the window. The surface holds its rows in `bodyLarge`
 * `onSurface`, with 8 px above and below, and scrolls when taller than the window.
 */
function menuLayer(node: Raw, scope: WebRenderScope, path: string, kit: WebRenderKit) {
  const hoisted = hoistedScope(scope);
  const items = Array.isArray(node.items) ? node.items : [];
  const { attrs, style } = kit.base(node, hoisted, {
    position: ABSOLUTE,
    "position-anchor": webAnchorName("menu", webMenuParentPath(path)),
    top: "anchor(bottom)",
    "inset-inline-end": "anchor(end)",
    "position-try-fallbacks": "flip-block, --pa-menu-clamp",
    display: FLEX,
    [FLEX_DIRECTION]: COLUMN,
    [BOX_SIZING]: BORDER_BOX,
    padding: "8px 0",
    "max-height": "100%",
    "overflow-y": "auto",
    color: role("onSurface", scope),
    ...textCss({ textStyle: "bodyLarge" }, scope.style),
    [POINTER_EVENTS]: "auto",
    ...menuSurfaceCss(scope),
  });
  const rows = items.flatMap((entry, index) => {
    const item = record(entry);
    if (!item) {
      return [];
    }
    return item.type === "divider"
      ? [menuDivider(scope)]
      : [menuRow(item, index, { node, scope: hoisted, kit })];
  });
  const surface = withOverContentLayers(
    el("div", { attrs: { ...attrs, role: "menu", [DATA_PART]: "menu" }, style }, rows),
    node.style,
    scope.style,
  );
  return el("div", { attrs: { [DATA_PART]: "menuLayer" }, style: CONTENTS_LAYER }, [surface]);
}

/** Where a tooltip points: the node its `anchorTo` names, else its bounds `anchor` in the window. */
type TooltipTarget = { readonly anchor: string } | { readonly bounds: Css };

function tooltipTarget(node: Raw): TooltipTarget | undefined {
  if (typeof node.anchorTo === "string") {
    return { anchor: webAnchorName("id", node.anchorTo) };
  }
  const anchor = record(node.anchor);
  const bounds = record(anchor?.bounds);
  if (anchor?.type !== "bounds" || !bounds) {
    return undefined;
  }
  const offset = record(anchor.offset);
  const at = (value: unknown, by: unknown) =>
    (typeof value === "number" ? value : 0) + (typeof by === "number" ? by : 0);
  return {
    bounds: {
      left: `${at(bounds.x, offset?.x)}px`,
      top: `${at(bounds.y, offset?.y)}px`,
      width: `${at(bounds.width, 0)}px`,
      height: `${at(bounds.height, 0)}px`,
    },
  };
}

/** The side of its target the bubble sits on; `auto` takes the space below, as a still cannot measure. */
function tooltipSide(caret: unknown): "below" | "above" | "start" | "end" {
  if (caret === "bottom") {
    return "above";
  }
  if (caret === "start") {
    return "end";
  }
  return caret === "end" ? "start" : "below";
}

/** The bubble's and caret's anchored placement on one side of the target, 8 px away. */
const SIDE_CSS: Readonly<Record<string, { bubble: Css; caret: Css; clip: string }>> = {
  below: {
    bubble: { "position-area": "block-end", "margin-top": "8px" },
    caret: { top: "anchor(bottom)", "justify-self": "anchor-center" },
    clip: "polygon(50% 0, 100% 100%, 0 100%)",
  },
  above: {
    bubble: { "position-area": "block-start", "margin-bottom": "8px" },
    caret: { bottom: "anchor(top)", "justify-self": "anchor-center" },
    clip: "polygon(0 0, 100% 0, 50% 100%)",
  },
  end: {
    bubble: { "position-area": "inline-end", "margin-inline-start": "8px" },
    caret: { "inset-inline-start": "anchor(end)", "align-self": "anchor-center" },
    clip: "polygon(0 50%, 100% 0, 100% 100%)",
  },
  start: {
    bubble: { "position-area": "inline-start", "margin-inline-end": "8px" },
    caret: { "inset-inline-end": "anchor(start)", "align-self": "anchor-center" },
    clip: "polygon(0 0, 100% 50%, 0 100%)",
  },
};

/**
 * The spotlight: the target's box grown by `padding` (8 px by default) with `cornerRadius`
 * corners (12 px), cut out of a window-wide scrim by its own shadow.
 */
function spotlight(node: Raw, anchor: string, scope: WebRenderScope): WebElement[] {
  const options = record(node.spotlight);
  if (!options) {
    return [];
  }
  const pad = typeof options.padding === "number" ? options.padding : 8;
  const radius = typeof options.cornerRadius === "number" ? options.cornerRadius : 12;
  const inset = (side: string) => `calc(anchor(${side}) - ${pad}px)`;
  return [
    el("div", {
      attrs: { [DATA_PART]: "spotlight", ...partTag(node, "close") },
      style: {
        position: ABSOLUTE,
        "position-anchor": anchor,
        top: inset("top"),
        bottom: inset("bottom"),
        left: inset("left"),
        right: inset("right"),
        [BORDER_RADIUS]: `${radius}px`,
        [BOX_SHADOW]: `0 0 0 9999px ${scrimCss(undefined, scope.style)}`,
      },
    }),
  ];
}

/**
 * A tooltip drawn open: an `inverseSurface` bubble of `bodyLarge` `inverseOnSurface` text with
 * 12 px around it, at most 320 px wide (280 on iOS), 8 px from its target on the side its `caret`
 * names (below for `auto`), with a 12 px caret pointing at the target and, when set, a spotlight
 * on it. A target the still cannot place (an element anchor) draws nothing, as on Android.
 */
function tooltipLayer(node: Raw, scope: WebRenderScope, path: string, kit: WebRenderKit) {
  const target = tooltipTarget(node);
  if (!target) {
    return el("div", { attrs: { [DATA_PART]: "tooltipLayer" }, style: CONTENTS_LAYER });
  }
  const hoisted = hoistedScope(scope);
  const ios = scope.skin === "ios";
  const fill = role("inverseSurface", scope);
  // A bounds anchor is an anchor of its own: an invisible box at the bounds, in the window.
  const anchorName = "anchor" in target ? target.anchor : webAnchorName("id", `${path}.anchor`);
  const boundsBox =
    "bounds" in target
      ? [
          el("div", {
            attrs: { [DATA_PART]: "anchor", "aria-hidden": "true" },
            style: {
              position: ABSOLUTE,
              ...target.bounds,
              "anchor-name": anchorName,
              [POINTER_EVENTS]: "none",
            },
          }),
        ]
      : [];
  const side = SIDE_CSS[tooltipSide(node.caret)]!;
  const { attrs, style } = kit.base(node, hoisted, {
    position: ABSOLUTE,
    "position-anchor": anchorName,
    ...side.bubble,
    [BOX_SIZING]: BORDER_BOX,
    padding: "12px",
    [MAX_WIDTH]: ios ? "min(280px, calc(100% - 16px))" : "min(320px, calc(100% - 16px))",
    [BORDER_RADIUS]: ios ? "12px" : "8px",
    [BACKGROUND_COLOR]: fill,
    color: role("inverseOnSurface", scope),
    ...textCss({ textStyle: "bodyLarge" }, scope.style),
    [WHITE_SPACE]: "pre-wrap",
    ...(ios ? {} : { [BOX_SHADOW]: "0 1.5px 3px rgba(0,0,0,0.25)" }),
    [POINTER_EVENTS]: "auto",
  });
  const bubble = withOverContentLayers(
    el("div", { attrs: { ...attrs, role: "tooltip", [DATA_PART]: "tooltip" }, style }, [
      kit.bound(node.text, hoisted),
    ]),
    node.style,
    scope.style,
  );
  const caret = el("div", {
    attrs: { [DATA_PART]: "caret", "aria-hidden": "true" },
    style: {
      position: ABSOLUTE,
      "position-anchor": anchorName,
      ...side.caret,
      width: "12px",
      height: "12px",
      [BACKGROUND_COLOR]: fill,
      "clip-path": side.clip,
    },
  });
  return el("div", { attrs: { [DATA_PART]: "tooltipLayer" }, style: CONTENTS_LAYER }, [
    ...boundsBox,
    ...spotlight(node, anchorName, scope),
    bubble,
    caret,
  ]);
}

export function webMenuLayers(kit: WebRenderKit): Readonly<Record<string, WebLayerRenderer>> {
  return {
    menu: openLayer((node, scope, path) => menuLayer(node, scope, path, kit)),
    tooltip: openLayer((node, scope, path) => tooltipLayer(node, scope, path, kit)),
  };
}
