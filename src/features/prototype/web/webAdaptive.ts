import { record, type Raw } from "../prototypeTemplate";
import { el, type WebChild, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import { cssColor, textCss } from "./webStyle";

type Css = Record<string, string>;

/** Material's window width classes, in dp: compact below 600, expanded from 840. */
const MEDIUM_DP = 600;
const EXPANDED_DP = 840;
/** Material's default list and supporting pane width, and the spacer between panes. */
const PANE_DP = 360;
const PANE_SPACER_DP = 24;

export type WebWidthClass = "compact" | "medium" | "expanded";

export function webWidthClass(width: number): WebWidthClass {
  if (width < MEDIUM_DP) {
    return "compact";
  }
  return width < EXPANDED_DP ? "medium" : "expanded";
}

interface AdaptiveContext {
  readonly node: Raw;
  readonly scope: WebRenderScope;
  readonly path: string;
  readonly kit: WebRenderKit;
}

function stateValue(key: unknown, ctx: AdaptiveContext): unknown {
  return typeof key === "string"
    ? ctx.scope.condition.state[ctx.kit.bound(key, ctx.scope)]
    : undefined;
}

/** A slot drawn in a pane, or nothing when the slot is absent or hidden. */
function slot(name: string, ctx: AdaptiveContext): WebChild[] {
  const inner = ctx.kit.child(ctx.scope, {
    inBox: false,
    style: { ...ctx.scope.style, parentAxis: "column", weightsChildren: false },
  });
  const drawn = ctx.kit.renderNode(ctx.node[name], inner, `${ctx.path}.${name}`);
  return drawn ? [drawn] : [];
}

function pane(name: string, css: Css, content: WebChild[]): WebElement {
  return el(
    "div",
    {
      attrs: { "data-pane": name },
      style: { display: "flex", "flex-direction": "column", "min-width": "0", ...css },
    },
    content,
  );
}

function textButton(label: string, tag: string, ctx: AdaptiveContext): WebElement {
  return el(
    "div",
    {
      attrs: { role: "button", "data-testid": tag },
      style: {
        display: "inline-flex",
        "align-items": "center",
        "align-self": "flex-start",
        "min-height": "40px",
        padding: "0 12px",
        ...textCss({ textStyle: "labelLarge" }, ctx.scope.style),
        color: cssColor("primary", ctx.scope.style) ?? "currentColor",
      },
    },
    [label],
  );
}

const testTagOf = (ctx: AdaptiveContext, path: string) =>
  typeof ctx.node.testTag === "string" ? ctx.node.testTag : path;

/** Two panes side by side: the fixed first pane, a 24 dp spacer, then the second filling. */
function twoPanes(first: WebElement, second: WebElement): WebChild[] {
  return [
    { ...first, style: { ...first.style, flex: `0 0 ${PANE_DP}px` } },
    el("div", { attrs: { "data-part": "spacer" }, style: { flex: `0 0 ${PANE_SPACER_DP}px` } }),
    { ...second, style: { ...second.style, flex: "1 1 0" } },
  ];
}

/**
 * List-detail: an expanded window shows both panes; otherwise the detail pane replaces the list
 * once the selection key holds a value, with a Back button above it. A slot is rendered only when
 * its pane shows, so a hidden pane's open sheet adds no layer.
 */
function listDetail(ctx: AdaptiveContext): WebChild[] {
  const selected = stateValue(ctx.node.selectionKey, ctx);
  const hasSelection = selected !== undefined && selected !== null && selected !== "";
  const list = () => pane("list", {}, slot("list", ctx));
  if (webWidthClass(ctx.scope.screenWidth) === "expanded") {
    return twoPanes(list(), pane("detail", {}, slot("detail", ctx)));
  }
  if (!hasSelection) {
    const only = list();
    return [{ ...only, style: { ...only.style, flex: "1 1 auto" } }];
  }
  const back = textButton("Back", `${testTagOf(ctx, ctx.path)}.back`, ctx);
  return [pane("detail", { flex: "1 1 auto" }, [back, ...slot("detail", ctx)])];
}

/**
 * Supporting pane: closed, only the main pane; open, an expanded window shows both, and a smaller
 * one shows the supporting pane alone. The supporting pane starts with a Close button. A slot is
 * rendered only when its pane shows.
 */
function supporting(ctx: AdaptiveContext): WebChild[] {
  const open = stateValue(ctx.node.openKey, ctx) === true;
  const main = () => pane("main", {}, slot("main", ctx));
  if (!open) {
    const only = main();
    return [{ ...only, style: { ...only.style, flex: "1 1 auto" } }];
  }
  const close = textButton("Close", `${testTagOf(ctx, ctx.path)}.close`, ctx);
  const expanded = webWidthClass(ctx.scope.screenWidth) === "expanded";
  const shown = expanded ? [main()] : [];
  const side = pane("supporting", {}, [close, ...slot("supporting", ctx)]);
  if (expanded) {
    return [
      { ...shown[0]!, style: { ...shown[0]!.style, flex: "1 1 0" } },
      el("div", { attrs: { "data-part": "spacer" }, style: { flex: `0 0 ${PANE_SPACER_DP}px` } }),
      { ...side, style: { ...side.style, flex: `0 0 ${PANE_DP}px` } },
    ];
  }
  return [{ ...side, style: { ...side.style, flex: "1 1 auto" } }];
}

interface SuiteItem {
  readonly value: string;
  readonly label: string;
}

function suiteItems(ctx: AdaptiveContext): SuiteItem[] {
  return (Array.isArray(ctx.node.items) ? ctx.node.items : []).flatMap((entry) => {
    const item = record(entry);
    return item ? [{ value: String(item.value), label: ctx.kit.bound(item.label, ctx.scope) }] : [];
  });
}

/** A navigation item: the label's first letter as its icon, in a pill when selected. */
function suiteItem(item: SuiteItem, index: number, layout: WebWidthClass, ctx: AdaptiveContext) {
  const selected = stateValue(ctx.node.stateKey, ctx) === item.value;
  const style = ctx.scope.style;
  const pill: Css = selected
    ? { "background-color": cssColor("secondaryContainer", style) ?? "transparent" }
    : {};
  const drawer = layout === "expanded";
  const icon = el(
    "span",
    {
      attrs: { "data-part": "icon" },
      style: {
        display: "inline-flex",
        "align-items": "center",
        "justify-content": "center",
        width: drawer ? "24px" : "56px",
        height: drawer ? "24px" : "32px",
        "border-radius": "16px",
        ...(drawer ? {} : pill),
      },
    },
    [item.label.slice(0, 1)],
  );
  return el(
    "div",
    {
      attrs: {
        role: "tab",
        "aria-selected": String(selected),
        "data-testid": `${testTagOf(ctx, ctx.path)}.item-${index}`,
      },
      style: {
        display: "flex",
        "flex-direction": drawer ? "row" : "column",
        "align-items": "center",
        gap: drawer ? "12px" : "4px",
        ...textCss({ textStyle: drawer ? "labelLarge" : "labelMedium" }, style),
        ...(drawer
          ? { height: "56px", padding: "0 16px", "border-radius": "28px", ...pill }
          : { flex: layout === "compact" ? "1 1 0" : "0 0 auto", padding: "12px 0 16px" }),
      },
    },
    [icon, item.label],
  );
}

/** The navigation suite: a bottom bar when compact, a rail when medium, a drawer when expanded. */
function navigationSuite(ctx: AdaptiveContext): WebChild[] {
  const layout = webWidthClass(ctx.scope.screenWidth);
  const items = suiteItems(ctx).map((item, index) => suiteItem(item, index, layout, ctx));
  const surface = layout === "expanded" ? "surfaceContainerLow" : "surfaceContainer";
  const bar = el(
    "div",
    {
      attrs: { role: "tablist", "data-part": "navigation", "data-layout": layout },
      style: {
        display: "flex",
        "flex-direction": layout === "compact" ? "row" : "column",
        ...(layout === "compact"
          ? { "min-height": "80px" }
          : { width: layout === "medium" ? "80px" : "360px", padding: "12px", gap: "4px" }),
        "box-sizing": "border-box",
        "flex-shrink": "0",
        ...ctx.kit.roleCss(ctx.scope, surface, "onSurface"),
      },
    },
    items,
  );
  const content = pane("content", { flex: "1 1 auto" }, slot("content", ctx));
  return layout === "compact" ? [content, bar] : [bar, content];
}

const KINDS: Readonly<Record<string, (ctx: AdaptiveContext) => WebChild[]>> = {
  listDetail,
  supporting,
  navigationSuite,
};

/**
 * An `adaptive` scaffold laid out for the frame's width class, as Material's adaptive scaffolds
 * place it on Android: list-detail and supporting panes side by side only when expanded, and a
 * navigation bar, rail or drawer by width. It fills its parent.
 */
const adaptiveRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope, path) => {
    const ctx: AdaptiveContext = { node, scope, path, kit };
    const vertical =
      node.kind === "navigationSuite" && webWidthClass(scope.screenWidth) === "compact";
    const { attrs, style } = kit.base(node, scope, {
      display: "flex",
      "flex-direction": vertical ? "column" : "row",
      "align-self": "stretch",
      flex: "1 1 auto",
      "min-height": "0",
    });
    const kind = KINDS[String(node.kind)];
    return el(
      "div",
      {
        attrs: {
          ...attrs,
          "data-kind": String(node.kind),
          "data-width-class": webWidthClass(scope.screenWidth),
        },
        style,
      },
      kind ? kind(ctx) : [],
    );
  };

export function webAdaptiveRenderers(kit: WebRenderKit): Record<string, NodeRenderer> {
  return { adaptive: adaptiveRenderer(kit) };
}
