import { walkPrototypeNodes } from "../prototypeNodeChildren";
import { record, type Raw } from "../prototypeTemplate";
import { el, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import { boxLayoutCss, cssColor } from "./webStyle";

type Css = Record<string, string>;

const px = (value: number): string => `${Number(value.toFixed(3))}px`;
const dp = (value: unknown): number => (typeof value === "number" && value > 0 ? value : 0);

/** The strip Android reserves for dots placed below a pager (its height, or width if vertical). */
const DOT_STRIP = 22;

export type WebAxis = "width" | "height";

/** The axes a node fills when it leaves them unsized, as its native Compose layout does. */
const DEFAULT_FILL: Readonly<Record<string, readonly WebAxis[]>> = {
  pager: ["width", "height"],
  grid: ["width"],
  carousel: ["width"],
  slider: ["width"],
  tabBar: ["width"],
  bottomNav: ["width"],
};

/** The axes a node fills by default and leaves unsized in its own style. */
export function defaultFillAxes(node: Raw): WebAxis[] {
  const style = record(node.style) ?? {};
  const axes = DEFAULT_FILL[String(node.type)] ?? [];
  return axes.filter((axis) => style[axis] === undefined);
}

/** Missing sizes on these axes become `fill`, without touching authored sizes. */
export function filling(node: Raw, axes: readonly WebAxis[]): Raw {
  const style = record(node.style) ?? {};
  const fills = Object.fromEntries(axes.map((axis) => [axis, "fill"]));
  return { ...node, style: { ...fills, ...style } };
}

/** A spacer with no width, height or weight fills its parent, as the native spacer does. */
export function isUnsizedSpacer(node: unknown): boolean {
  const raw = record(node);
  const style = record(raw?.style) ?? {};
  return (
    raw?.type === "spacer" &&
    style.width === undefined &&
    style.height === undefined &&
    style.weight === undefined
  );
}

/** Missing width and height default to `fill`, without touching authored sizes. */
function fillMissing(node: Raw): Raw {
  return filling(node, ["width", "height"]);
}

/** An unsized spacer with its missing width and height filled; other nodes unchanged. */
export function spacerFilled(node: Raw): Raw {
  return isUnsizedSpacer(node) ? fillMissing(node) : node;
}

/** The page a pager opens on: its numeric state value clamped to its pages and truncated, else 0. */
export function pagerPage(node: Raw, scope: WebRenderScope, kit: WebRenderKit): number {
  const count = Array.isArray(node.children) ? node.children.length : 0;
  const key = typeof node.stateKey === "string" ? kit.bound(node.stateKey, scope) : undefined;
  const value = key === undefined ? undefined : scope.condition.state[key];
  if (typeof value !== "number" || !Number.isFinite(value) || count === 0) {
    return 0;
  }
  return Math.trunc(Math.min(Math.max(value, 0), count - 1));
}

/**
 * The scope a node's own conditions and its content read: for a pager, its one-based `page` and
 * `pageCount` over any outer locals, as Android builds them before evaluating the pager itself.
 */
export function withPagerLocals(
  node: Raw,
  scope: WebRenderScope,
  kit: WebRenderKit,
): WebRenderScope {
  if (node.type !== "pager") {
    return scope;
  }
  const count = Array.isArray(node.children) ? node.children.length : 0;
  const page = pagerPage(node, scope, kit) + 1;
  return { ...scope, textLocals: { ...scope.textLocals, page, pageCount: count } };
}

/** The initial page of the spec's pager with this id, for a tab bar or bottom nav linked to it. */
export function linkedPagerPage(
  id: string,
  scope: WebRenderScope,
  kit: WebRenderKit,
): number | undefined {
  let found: Raw | undefined;
  walkPrototypeNodes(scope.spec, (node) => {
    if (!found && node.type === "pager" && node.id === id) {
      found = node;
    }
  });
  return found ? pagerPage(found, scope, kit) : undefined;
}

/** Pages fill the pager unless it is explicitly wrap on that axis or a fixed size sets that axis. */
function pageFill(node: Raw, vertical: boolean): { width: boolean; height: boolean } {
  const style = record(node.style) ?? {};
  const fixed = typeof record(node.pageSize)?.dp === "number";
  return {
    width: style.width !== "wrap" && (!fixed || vertical),
    height: style.height !== "wrap" && (!fixed || !vertical),
  };
}

/**
 * The page box. The pager lays the page and any indicator strip out across its axis (a column for a
 * horizontal pager), so the page grows along that line to fill the pager's other axis and stretches
 * across it to fill the pager's own axis; a fixed page size sets the pager's axis instead.
 */
function pageCss(node: Raw, vertical: boolean): Css {
  const fill = pageFill(node, vertical);
  const size = record(node.pageSize)?.dp;
  const css: Css = { ...boxLayoutCss(undefined), "min-width": "0", "min-height": "0" };
  if (vertical ? fill.width : fill.height) {
    css.flex = "1 1 auto";
  }
  if (vertical ? fill.height : fill.width) {
    css["align-self"] = "stretch";
  } else if (typeof size === "number") {
    css[vertical ? "height" : "width"] = px(size);
    css["align-self"] = "flex-start";
  }
  return css;
}

/** Peek insets the page on the pager's axis, as contentPadding does. */
function peekCss(node: Raw, vertical: boolean): Css {
  const peek = record(node.peek);
  const start = dp(peek?.start);
  const end = dp(peek?.end);
  const css: Css = {};
  if (start > 0) {
    css[vertical ? "padding-top" : "padding-inline-start"] = px(start);
  }
  if (end > 0) {
    css[vertical ? "padding-bottom" : "padding-inline-end"] = px(end);
  }
  return css;
}

/**
 * Android's dots: 6 px, 8 px apart, the current page in onSurface and the rest at 0.38. Over the
 * pager they sit 8 px from its bottom (a vertical pager: its right edge); below it they centre in a
 * 22 px strip.
 */
function pagerDots(
  count: number,
  page: number,
  layout: { vertical: boolean; over: boolean },
  scope: WebRenderScope,
): WebElement {
  const color = cssColor("onSurface", scope.style) ?? "currentColor";
  const dots = Array.from({ length: count }, (_unused, index) =>
    el("span", {
      attrs: { "data-part": "dot" },
      style: {
        width: "6px",
        height: "6px",
        "border-radius": "50%",
        "background-color": color,
        ...(index === page ? {} : { opacity: "0.38" }),
      },
    }),
  );
  const axis: Css = {
    display: "flex",
    "flex-direction": layout.vertical ? "column" : "row",
    "align-items": "center",
    "justify-content": "center",
    gap: "8px",
  };
  const placement: Css = layout.over
    ? layout.vertical
      ? { position: "absolute", top: "0", bottom: "0", right: "8px" }
      : { position: "absolute", left: "0", right: "0", bottom: "8px" }
    : layout.vertical
      ? { width: px(DOT_STRIP), "align-self": "stretch", "flex-shrink": "0" }
      : { height: px(DOT_STRIP), "align-self": "stretch", "flex-shrink": "0" };
  return el(
    "div",
    {
      attrs: { "data-part": "indicator", "aria-hidden": "true" },
      style: { ...axis, ...placement, "pointer-events": "none" },
    },
    dots,
  );
}

/**
 * Whether a pager can reserve the dot strip: Android draws the dots over the pages when a fixed
 * cross-axis size (height, or width for a vertical pager) leaves less than another strip for them.
 */
function canReserveStrip(node: Raw, vertical: boolean): boolean {
  const extent = record(record(node.style)?.[vertical ? "width" : "height"])?.dp;
  return typeof extent !== "number" || extent - DOT_STRIP >= DOT_STRIP;
}

/**
 * A pager draws its initial page filling it, as both devices open it. The still never scrolls, so
 * neighbours a peek would reveal are not drawn.
 */
export const pagerRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (raw, scope, path) => {
    const node = filling(raw, defaultFillAxes(raw));
    const vertical = node.axis === "vertical";
    const pages = Array.isArray(node.children) ? node.children : [];
    const page = pagerPage(node, scope, kit);
    const dots = node.indicator === "dots" && pages.length > 0;
    const over = node.indicatorPlacement !== "below" || !canReserveStrip(node, vertical);
    const { attrs, style } = kit.base(node, scope, {
      display: "flex",
      "flex-direction": vertical ? "row" : "column",
      overflow: "hidden",
      position: "relative",
    });
    // The page inherits the locals renderWebNode set for this pager (`page`, `pageCount`).
    const inner = kit.child(scope, {
      inBox: true,
      style: { ...scope.style, parentAxis: undefined },
    });
    const content = kit.renderNode(pages[page], inner, `${path}.children[${page}]`);
    const pageBox = el(
      "div",
      { attrs: { "data-part": "page" }, style: pageCss(node, vertical) },
      content ? [content] : [],
    );
    // Peek pads an inner viewport, so it adds to the pager's own padding as contentPadding does.
    const viewport = el(
      "div",
      {
        attrs: { "data-part": "viewport" },
        style: {
          display: "flex",
          "flex-direction": vertical ? "row" : "column",
          flex: "1 1 auto",
          "align-self": "stretch",
          "min-width": "0",
          "min-height": "0",
          ...peekCss(node, vertical),
        },
      },
      [pageBox],
    );
    const indicator = dots ? [pagerDots(pages.length, page, { vertical, over }, scope)] : [];
    return el("div", { attrs, style }, [viewport, ...indicator]);
  };

/**
 * The grid's column count. An adaptive grid fits `floor((available + gap) / (minWidth + gap))`, as
 * Android does; the still takes the screen width as the available width, so its tracks and its
 * clamped spans always agree.
 */
function gridColumnCount(columns: unknown, available: number, gap: number): number {
  if (typeof columns === "number") {
    return Math.max(1, Math.trunc(columns));
  }
  const minWidth = record(columns)?.minWidth;
  return typeof minWidth === "number"
    ? Math.max(1, Math.floor((available + gap) / (minWidth + gap)))
    : 1;
}

/**
 * A grid cell spans its `span`, clamped to the columns, and takes the cell's width whatever its own
 * width says, top-aligned in its row, as Android measures each child at its cell width.
 */
const gridCell =
  (columns: number) =>
  (element: WebElement | undefined, authored: Raw): WebElement | undefined => {
    if (!element) {
      return undefined;
    }
    const span = typeof authored.span === "number" ? Math.trunc(authored.span) : 1;
    const style: Css = { ...element.style };
    // Android measures the child at exactly its cell width, so neither width nor maxWidth narrows it.
    delete style.width;
    delete style["max-width"];
    delete style.flex;
    if (style.height === "100%") {
      delete style.height;
    }
    return {
      ...element,
      style: {
        ...style,
        "grid-column": `span ${Math.min(Math.max(1, span), columns)}`,
        "justify-self": "stretch",
        "align-self": "start",
        "min-width": "0",
      },
    };
  };

/**
 * A grid is an eager CSS grid: rows pack row-major and a child that does not fit starts the next
 * row, as on Android. Column spacing is `spacing`, row spacing `runSpacing` (else `spacing`).
 */
export const gridRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (raw, scope, path) => {
    const node = filling(raw, defaultFillAxes(raw));
    const style = record(node.style) ?? {};
    const gap = dp(style.spacing);
    const rowGap = typeof style.runSpacing === "number" ? dp(style.runSpacing) : gap;
    const columns = gridColumnCount(node.columns, scope.screenWidth, gap);
    const base = kit.base(node, scope, {
      display: "grid",
      "grid-template-columns": `repeat(${columns}, minmax(0, 1fr))`,
      "column-gap": px(gap),
      "row-gap": px(rowGap),
      "align-items": "start",
      // A grid taller than its rows keeps them at the top, as Android places them.
      "align-content": "start",
    });
    const inner = kit.child(scope, {
      inBox: false,
      style: { ...scope.style, parentAxis: undefined },
    });
    return el("div", base, kit.children(node, inner, path, gridCell(columns)));
  };

/**
 * A carousel draws its items in a clipped row at `itemWidth`, `itemSpacing` apart, each masked
 * with Material's extra-large (28 dp) shape as Android does. The still shows the opening position
 * at the item width; it does not reproduce multi-browse or hero keyline resizing.
 */
export const carouselRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (raw, scope, path) => {
    const node = filling(raw, defaultFillAxes(raw));
    const { attrs, style } = kit.base(node, scope, {
      display: "flex",
      "flex-direction": "row",
      overflow: "hidden",
      gap: px(dp(node.itemSpacing)),
    });
    const inner = kit.child(scope, {
      inBox: true,
      style: { ...scope.style, parentAxis: undefined },
    });
    // Android keeps an item slot for every child, hiding only a hidden child's content.
    const item = (entry: WebElement | undefined): WebElement =>
      el(
        "div",
        {
          attrs: { "data-part": "item" },
          style: {
            ...boxLayoutCss(undefined),
            flex: `0 0 ${px(dp(node.itemWidth))}`,
            "border-radius": "28px",
            overflow: "hidden",
          },
        },
        entry ? [entry] : [],
      );
    const items = kit.children(node, inner, path, item);
    return el("div", { attrs, style }, items);
  };

export function webCollectionRenderers(kit: WebRenderKit): Record<string, NodeRenderer> {
  return {
    pager: pagerRenderer(kit),
    grid: gridRenderer(kit),
    carousel: carouselRenderer(kit),
  };
}
