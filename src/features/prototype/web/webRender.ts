import { bindPrototypeDataText, resolvePrototypeDataPointer } from "../prototypeData";
import {
  projectPrototypeDerivedItem,
  resolvePrototypeDerived,
  type PrototypeFormatEnvironment,
} from "../prototypeFormat";
import {
  bindText,
  bindTyped,
  mapBindableFields,
  record,
  renderScalar,
  type Instance,
  type Raw,
} from "../prototypeTemplate";
import {
  defaultFillAxes,
  filling,
  isUnsizedSpacer,
  spacerFilled,
  webCollectionRenderers,
  withPagerLocals,
  type WebAxis,
} from "./webCollections";
import { conditionHolds, decide, type ConditionScope } from "./webCondition";
import { webControlRenderers } from "./webControls";
import { webMapRenderers } from "./webMap";
import { webMediaRenderers } from "./webMedia";
import { bindStillPlatformText } from "./webPlatformState";
import { webRepeatLimit, webRepeatRows } from "./webRepeat";
import { webSheetLayers } from "./webSheet";
import { webStackRenderers, type WebStackScreens } from "./webStack";
import { el, type WebChild, type WebElement } from "./webNodes";
import {
  boxLayoutCss,
  cssColor,
  lineCss,
  nodeCss,
  textCss,
  type WebStyleContext,
} from "./webStyle";
import { safeAreaCss, safeAreaEdges } from "./webInsets";
import { fadeEdgesCss, shaderFallback, withOverContentLayers } from "./webStylePolish";
import { textRuns } from "./webText";
import { rowFillAxes, rowMeasured } from "./webRowAspect";
import { withChildHeights } from "./webIncomingHeight";

/** A node the web renderer drew as a labelled placeholder instead of its real content. */
export interface UnsupportedWebNode {
  readonly type: string;
  readonly id?: string;
  readonly path: string;
  /**
   * `shaderFallback`: the node drew without its `style.shader`, as a device that cannot run the
   * shader does.
   */
  readonly reason: "unsupportedType" | "assetNotInlined" | "shaderFallback";
}

/** Everything one render pass reads, plus where it records placeholders. */
export interface WebRenderScope {
  readonly style: WebStyleContext;
  readonly condition: ConditionScope;
  readonly data: unknown;
  /** The expanded spec, for its top-level `derive` entries. */
  readonly spec: Raw;
  /** Locale, time zone and a fixed clock, so derived text is the same on every render. */
  readonly format: PrototypeFormatEnvironment;
  /** Repeat item bindings, innermost last. Spec state binds after them. */
  readonly instances: readonly Instance[];
  readonly inBox: boolean;
  readonly unsupported: UnsupportedWebNode[];
  /** The screen width in dp for the orientation, which an adaptive grid fits its columns to. */
  readonly screenWidth: number;
  /**
   * A pager's `page` and `pageCount`: text placeholders and every condition (`visibleWhen`,
   * `styleWhen`, `enabledWhen`, `errorWhen`) read them, as Android's local pager state does; a
   * control's own value and a pager's selection never do.
   */
  readonly textLocals?: Readonly<Record<string, unknown>>;
  /** The screen the outermost stack draws instead of its start; an unknown id draws the start. */
  readonly screen?: string;
  /** Collects the outermost stack drawn, the one `screen` applies to; nested stacks draw start. */
  readonly stacks?: WebStackScreens[];
  /** What the window draws above the whole tree (an open bottomSheet), in tree order. */
  readonly layers: WebElement[];
  /** Safe-area edges an ancestor already applied. */
  readonly consumedInsets?: readonly string[];
  /** Safe-area edges the node being rendered applies, consumed for its descendants. */
  readonly ownInsets?: readonly string[];
}

export type NodeRenderer = (node: Raw, scope: WebRenderScope, path: string) => WebElement;

/** The shared drawing helpers the control and collection renderers build on. */
export interface WebRenderKit {
  readonly base: typeof base;
  readonly child: typeof child;
  readonly children: typeof children;
  readonly bound: typeof bound;
  readonly icon: NodeRenderer;
  readonly roleCss: typeof roleCss;
  readonly disabledState: typeof disabledState;
  readonly renderNode: typeof renderWebNode;
  readonly safeAreaEdges: typeof safeAreaEdges;
}

/** `{key}` reads state; `{derived:name}` reads a top-level derived value, as on the devices. */
function bindBare(text: string, scope: WebRenderScope): string {
  return text.replace(/\{([^{}]+)\}/g, (whole, inner: string) => {
    if (!inner.startsWith("derived:")) {
      const key = unshield(inner);
      const locals = scope.textLocals ?? {};
      if (Object.hasOwn(locals, key)) {
        return shield(renderScalar(locals[key]));
      }
      return Object.hasOwn(scope.condition.state, key)
        ? shield(renderScalar(scope.condition.state[key]))
        : whole;
    }
    const name = inner.slice("derived:".length);
    const derive = record(scope.spec.derive);
    return derive && Object.hasOwn(derive, name)
      ? shield(
          resolvePrototypeDerived(
            scope.spec as Parameters<typeof resolvePrototypeDerived>[0],
            name,
            { data: scope.data, state: scope.condition.state, env: scope.format },
          ),
        )
      : whole;
  });
}

export function bound(text: unknown, scope: WebRenderScope): string {
  if (typeof text !== "string") {
    return "";
  }
  // Data and platform placeholders bind first, then repeat items, then state, as the devices bind
  // text. Every inserted value is shielded until the end, so it is never read again as a
  // placeholder. Authored text is escaped too, so lookups read each placeholder's key unescaped.
  const fromData = bindPrototypeDataText(escaped(text), (pointer) => {
    const value = resolvePrototypeDataPointer(scope.data, unshield(pointer));
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? shield(renderScalar(value))
      : "";
  });
  const data = bindStillPlatformText(fromData, scope.condition.platformState, unshield, shield);
  const items = [...scope.instances]
    .reverse()
    .reduce((value, instance) => bindText(value, shieldedInstance(instance)), data);
  return unshield(bindBare(items, scope));
}

/**
 * Braces in an inserted value become escapes until binding is done. The escape character is itself
 * escaped wherever it already appears (authored or inserted), so every character survives exactly.
 */
const ESCAPE = "\uE000";
const escaped = (value: string) => value.replaceAll(ESCAPE, `${ESCAPE}e`);
const shield = (value: string) =>
  escaped(value).replaceAll("{", `${ESCAPE}o`).replaceAll("}", `${ESCAPE}c`);
const UNESCAPED: Readonly<Record<string, string>> = { e: ESCAPE, o: "{", c: "}" };
const unshield = (value: string) =>
  value.replace(/\uE000([eoc])/g, (_whole, kind: string) => UNESCAPED[kind]!);

function shieldedInstance(instance: Instance): Instance {
  const values = Object.fromEntries(
    Object.entries(instance.values).map(([key, value]) => [
      key,
      typeof value === "string" ? shield(value) : value,
    ]),
  );
  return { ...instance, values };
}

function base(node: Raw, scope: WebRenderScope, extra: Record<string, string> = {}) {
  const attrs: Record<string, string> = { "data-node": String(node.type) };
  if (typeof node.testTag === "string") {
    attrs["data-testid"] = node.testTag;
  }
  // As the native mapper resolves it: semantics.label, then the legacy contentDescription.
  const label = record(node.semantics)?.label ?? node.contentDescription;
  if (typeof label === "string") {
    attrs["aria-label"] = bound(label, scope);
  }
  // Component defaults first, so the spec's own style wins, as on both devices.
  const style = {
    ...extra,
    ...nodeCss(node.style, scope.style),
    ...textCss(record(node.style), scope.style),
    ...(scope.inBox ? { "grid-area": "cell" } : {}),
  };
  // Per-corner radii are longhands; a component's default shorthand would sort after some of them
  // and reset those corners, so it goes when the spec sets its own corners.
  if ("border-start-start-radius" in style) {
    delete (style as Record<string, string>)["border-radius"];
  }
  return { attrs, style: safeAreaCss(node, scope, style) };
}

function child(scope: WebRenderScope, patch: Partial<WebRenderScope>): WebRenderScope {
  // Descendants see the insets this node applied as consumed.
  const consumedInsets = [...(scope.consumedInsets ?? []), ...(scope.ownInsets ?? [])];
  return {
    ...scope,
    ...patch,
    style: { ...scope.style, ...patch.style },
    consumedInsets,
    ownInsets: [],
  };
}

/**
 * Lets a container decorate each child, given the child node it was drawn from. A hidden child
 * arrives as undefined, so a container that keeps a slot for every child (a carousel) can still
 * draw one; returning undefined draws nothing.
 */
export type WebCellDecorator = (
  element: WebElement | undefined,
  authored: Raw,
) => WebElement | undefined;

export function children(
  node: Raw,
  scope: WebRenderScope,
  path: string,
  cell?: WebCellDecorator,
): WebChild[] {
  const list = Array.isArray(node.children) ? node.children : [];
  const repeat = record(node.repeat);
  if (!repeat) {
    return list.flatMap((entry, index) =>
      renderOrSkip(entry, scope, `${path}.children[${index}]`, cell),
    );
  }
  const rows = webRepeatRows(repeat, scope.data, webRepeatLimit(node));
  const alias = typeof repeat.as === "string" ? repeat.as : "item";
  const derive = record(repeat.derive) as
    | Parameters<typeof projectPrototypeDerivedItem>[0]
    | undefined;
  return rows.flatMap((item, index) => {
    const values = record(item) ?? {};
    const instance: Instance = {
      binding: { alias, index: true },
      values: derive ? projectPrototypeDerivedItem(derive, values, scope.format) : values,
      index,
    };
    const itemScope = child(scope, { instances: [...scope.instances, instance] });
    return list.flatMap((entry, at) =>
      renderOrSkip(entry, itemScope, `${path}.children[${at}]`, cell),
    );
  });
}

function renderOrSkip(
  node: unknown,
  scope: WebRenderScope,
  path: string,
  cell?: WebCellDecorator,
): WebChild[] {
  const rendered = renderWebNode(node, scope, path);
  const drawn = cell ? cell(rendered, record(node) ?? {}) : rendered;
  return drawn ? [drawn] : [];
}

/**
 * The axes a child will fill in its line: both for a visible unsized spacer, else those its type
 * fills by default (a slider's width, say). Its repeat placeholders bind, its visibleWhen must keep
 * it, and its style includes matching styleWhen entries.
 */
function childFillAxes(entry: unknown, scope: WebRenderScope, path: string): WebAxis[] {
  const prepared = preparedNode(entry, scope, path);
  if (!prepared) {
    return [];
  }
  const { styled, scope: local } = prepared;
  if (isUnsizedSpacer(styled)) {
    return ["width", "height"];
  }
  const style = record(styled.style) ?? {};
  // An authored `fill` grows the parent just as a default fill does (fillMax either way).
  const authored = (["width", "height"] as const).filter((axis) => style[axis] === "fill");
  // A nested line or card grows around its own filling child, so its parent grows too.
  const inferred = GROWING_CONTAINERS.has(String(styled.type))
    ? lineFillAxes(heightsIn(styled, local, path), local, path).filter(
        (axis) => style[axis] === undefined,
      )
    : defaultFillAxes(styled);
  return [...authored, ...inferred];
}

/** Containers that grow on an axis when a child fills it, as a Compose parent does. */
const GROWING_CONTAINERS: ReadonlySet<string> = new Set(["row", "column", "box", "card"]);

/**
 * The axes on which a container grows because a child fills them; a repeat with no rows renders
 * no children.
 */
function lineFillAxes(raw: Raw, scope: WebRenderScope, path: string): WebAxis[] {
  const repeat = record(raw.repeat);
  if (
    !Array.isArray(raw.children) ||
    (repeat && webRepeatRows(repeat, scope.data, webRepeatLimit(raw)).length === 0)
  ) {
    return [];
  }
  const own = rowFillAxes(raw, path, prepareIn(scope));
  const axes = new Set([...own, ...raw.children.flatMap((e) => childFillAxes(e, scope, path))]);
  return (["width", "height"] as const).filter((axis) => axes.has(axis));
}

const prepareIn = (s: WebRenderScope) => (e: unknown, at: string) => preparedNode(e, s, at)?.styled;
const heightsIn = (n: Raw, s: WebRenderScope, at: string) => withChildHeights(n, at, prepareIn(s));

const line =
  (axis: "row" | "column"): NodeRenderer =>
  (raw, scope, path) => {
    // A wrap-sized line around a filling child grows to its parent on that axis, as a Compose
    // parent does around a fillMax child; otherwise it would shrink to nothing.
    const sized = heightsIn(raw, scope, path);
    const node = filling(sized, lineFillAxes(sized, scope, path));
    const lineStyle = { ...scope.style, parentAxis: axis, weightsChildren: true };
    const inner = child(scope, { inBox: false, style: lineStyle });
    const rowed = rowMeasured(node, path, prepareIn(inner));
    const { attrs, style } = base(rowed, scope, lineCss(axis, rowed.style));
    return el("div", { attrs, style }, children(rowed, inner, path));
  };

const box: NodeRenderer = (raw, scope, path) => {
  // A wrap-sized box grows around a filling child, as a Compose Box does; each child carries the
  // height the box hands it.
  const sized = heightsIn(raw, scope, path);
  const node = filling(sized, lineFillAxes(sized, scope, path));
  const { attrs, style } = base(node, scope, boxLayoutCss(node.style));
  const inner = child(scope, { inBox: true, style: { ...scope.style, parentAxis: undefined } });
  return el("div", { attrs, style }, children(node, inner, path));
};

const text: NodeRenderer = (node, scope) => {
  const maxLines = record(node.style)?.maxLines;
  const clamp: Record<string, string> =
    typeof maxLines === "number"
      ? {
          display: "-webkit-box",
          "-webkit-box-orient": "vertical",
          "-webkit-line-clamp": String(maxLines),
          overflow: "hidden",
        }
      : {};
  const { attrs, style } = base(node, scope, { ...clamp, "white-space": "pre-wrap" });
  return el(
    "span",
    { attrs, style },
    textRuns(node, (value) => bound(value, scope), scope.style),
  );
};

const scroll: NodeRenderer = (node, scope, path) => {
  const horizontal = node.axis === "horizontal";
  const fade = fadeEdgesCss(node, scope.style);
  const { attrs, style } = base(node, scope, {
    display: "flex",
    // A reverse scroll starts at its end, as reverseScrolling does; its one child keeps its order.
    "flex-direction": `${horizontal ? "row" : "column"}${node.reverse === true ? "-reverse" : ""}`,
    // Like the native start-aligned Box, wrap-sized content keeps its own cross-axis size.
    "align-items": "flex-start",
    [horizontal ? "overflow-x" : "overflow-y"]: "auto",
    ...fade.style,
  });
  const inner = child(scope, {
    inBox: false,
    style: { ...scope.style, parentAxis: horizontal ? "row" : "column", weightsChildren: false },
  });
  const scrollAttrs = { ...attrs, ...fade.attrs };
  return el("div", { attrs: scrollAttrs, style }, renderOrSkip(node.child, inner, `${path}.child`));
};

const spacer: NodeRenderer = (node, scope) => el("div", base(spacerFilled(node), scope));

const divider: NodeRenderer = (node, scope) => {
  const vertical = node.orientation === "vertical";
  // The authored colour paints the line, as natively; otherwise outlineVariant.
  const color =
    cssColor(record(node.style)?.color, scope.style) ??
    cssColor("outlineVariant", scope.style) ??
    "rgba(0,0,0,0.12)";
  return el(
    "div",
    base(
      node,
      scope,
      vertical
        ? { width: "1px", "align-self": "stretch", "background-color": color }
        : // Inside a box grid the line axis is horizontal, so it stretches there too.
          {
            height: "1px",
            "align-self": "stretch",
            "justify-self": "stretch",
            "background-color": color,
          },
    ),
  );
};

/** The first letter of an icon's name, so a placeholder reads as that icon; none without a name. */
function iconInitial(name: unknown): string {
  const letter = typeof name === "string" ? /[a-z0-9]/i.exec(name)?.[0] : undefined;
  return letter ? letter.toUpperCase() : "";
}

const icon: NodeRenderer = (node, scope) => {
  // The Material glyph set is not inlined, so an icon draws as a tinted ring around its name's
  // initial, titled with the full name.
  const { attrs, style } = base(node, scope, {
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    width: "24px",
    height: "24px",
    border: "2px solid currentColor",
    "border-radius": "6px",
    "font-size": "11px",
    "font-weight": "700",
    "line-height": "1",
    "flex-shrink": "0",
  });
  return el("span", { attrs: { ...attrs, title: String(node.name ?? ""), role: "img" }, style }, [
    iconInitial(node.name),
  ]);
};

const image: NodeRenderer = (node, scope, path) => {
  scope.unsupported.push({
    type: "image",
    ...(typeof node.id === "string" ? { id: node.id } : {}),
    path,
    reason: "assetNotInlined",
  });
  const { attrs, style } = base(node, scope, {
    "background-color": cssColor("surfaceVariant", scope.style) ?? "#e7e0ec",
    "min-height": "48px",
    "min-width": "48px",
  });
  return el("div", { attrs: { ...attrs, role: "img" }, style });
};

function roleCss(
  scope: WebRenderScope,
  background: string,
  foreground: string,
): Record<string, string> {
  const css: Record<string, string> = {};
  const bg = cssColor(background, scope.style);
  const fg = cssColor(foreground, scope.style);
  if (bg) {
    css["background-color"] = bg;
  }
  if (fg) {
    css.color = fg;
  }
  return css;
}

const BUTTON_ROLES: Readonly<Record<string, [string, string]>> = {
  filled: ["primary", "onPrimary"],
  tonal: ["secondaryContainer", "onSecondaryContainer"],
  elevated: ["surfaceContainerLow", "primary"],
};

/**
 * A control whose enabledWhen is decidably false draws disabled (Material's 0.38 opacity) and
 * says so to assistive tech, as the native controls do. Undecidable conditions stay enabled.
 */
function disabledState(
  node: Raw,
  scope: WebRenderScope,
): { css: Record<string, string>; attrs: Record<string, string> } {
  const enabled =
    node.enabledWhen === undefined || conditionHolds(node.enabledWhen, presentation(scope));
  return enabled
    ? { css: {}, attrs: {} }
    : { css: { opacity: "0.38" }, attrs: { "aria-disabled": "true" } };
}

const button: NodeRenderer = (node, scope) => {
  const disabled = disabledState(node, scope);
  const variant = typeof node.variant === "string" ? node.variant : "filled";
  const roles = BUTTON_ROLES[variant];
  const outline: Record<string, string> =
    variant === "outlined"
      ? { border: `1px solid ${cssColor("outline", scope.style) ?? "currentColor"}` }
      : {};
  const { attrs, style } = base(node, scope, {
    display: "inline-flex",
    "align-items": "center",
    "justify-content": "center",
    "min-height": "40px",
    padding: "0 24px",
    "border-radius": "20px",
    "font-weight": "500",
    ...(roles ? roleCss(scope, roles[0], roles[1]) : roleCss(scope, "transparent", "primary")),
    gap: "8px",
    ...outline,
    ...disabled.css,
  });
  return el("div", { attrs: { ...attrs, role: "button", ...disabled.attrs }, style }, [
    ...namedIcon(node.icon, scope),
    bound(node.label, scope),
  ]);
};

/** App-bar navigation and action slots draw as icon placeholders labelled with their action. */
function appBarIcons(slots: readonly unknown[], scope: WebRenderScope, path: string): WebElement[] {
  return slots.flatMap((slot) => {
    const action = record(slot);
    if (typeof action?.icon !== "string") {
      return [];
    }
    const glyph = icon({ type: "icon", name: action.icon }, scope, path);
    const label = typeof action.label === "string" ? bound(action.label, scope) : action.icon;
    return [
      el("span", { attrs: { role: "button", "aria-label": label }, style: { padding: "12px" } }, [
        glyph,
      ]),
    ];
  });
}

/**
 * Material 3 top app bar sizes: small and center-aligned are 64 dp with a 22 sp title; medium and
 * large put a 28 or 36 sp title below the icon row, in a 112 or 152 dp bar.
 */
const APP_BAR_VARIANTS: Readonly<Record<string, { height: number; title: number }>> = {
  small: { height: 64, title: 22 },
  centerAligned: { height: 64, title: 22 },
  medium: { height: 112, title: 28 },
  large: { height: 152, title: 36 },
};

/**
 * An expanded bar's title takes its own line below the icons; a center-aligned title is centred
 * on the whole bar, whatever slots sit beside it; a small bar's title fills the space between.
 */
function appBarTitleStyle(variant: string, expanded: boolean): Record<string, string> {
  if (expanded) {
    return { order: "1", "flex-basis": "100%", "padding-bottom": "16px" };
  }
  return variant === "centerAligned"
    ? {
        position: "absolute",
        left: "0",
        right: "0",
        "text-align": "center",
        "pointer-events": "none",
      }
    : { flex: "1 1 auto" };
}

const topAppBar: NodeRenderer = (node, scope, path) => {
  const variant = typeof node.variant === "string" ? node.variant : "small";
  const size = APP_BAR_VARIANTS[variant] ?? APP_BAR_VARIANTS.small!;
  const expanded = variant === "medium" || variant === "large";
  const { attrs, style } = base(node, scope, {
    display: "flex",
    "flex-wrap": expanded ? "wrap" : "nowrap",
    "align-items": "center",
    "align-content": "space-between",
    // Like the native bar, it takes no window insets of its own: status-bar clearance comes only
    // from an authored safeAreaPadding.
    "min-height": `${size.height}px`,
    "padding-inline": "16px",
    "font-size": `${size.title}px`,
    "align-self": "stretch",
    position: "relative",
    ...roleCss(scope, "surface", "onSurface"),
  });
  const actions = Array.isArray(node.actions) ? node.actions : [];
  const title = el("span", { style: appBarTitleStyle(variant, expanded) }, [
    bound(node.title, scope),
  ]);
  return el("div", { attrs: { ...attrs, role: "heading" }, style }, [
    ...appBarIcons([node.navigationIcon], scope, path),
    title,
    // When the title leaves the flow (its own line, or centred on the bar), a spacer keeps the
    // actions at the end.
    ...(expanded || variant === "centerAligned"
      ? [el("span", { style: { flex: "1 1 auto" } })]
      : []),
    ...appBarIcons(actions, scope, path),
  ]);
};

/** The typed value (masked when secure), or the placeholder when the field is empty. */
function fieldValue(node: Raw, scope: WebRenderScope): { shown: string; empty: boolean } {
  // A state key inside a repeat may hold item placeholders, which bind first.
  const key = typeof node.stateKey === "string" ? bound(node.stateKey, scope) : undefined;
  const value = key === undefined ? undefined : scope.condition.state[key];
  if (typeof value !== "string" || value === "") {
    return { shown: bound(node.placeholder ?? node.label, scope), empty: true };
  }
  // A secure field never shows its value, as the native password transformation does.
  const secure = node.secure === true || node.keyboardType === "password";
  return { shown: secure ? "•".repeat([...value].length) : value, empty: false };
}

/** A multiline field keeps its newlines and its authored minLines and maxLines (24px lines). */
function lineBounds(node: Raw): Record<string, string> {
  if (node.multiline !== true) {
    return {};
  }
  const css: Record<string, string> = { "white-space": "pre-wrap", "line-height": "24px" };
  if (typeof node.minLines === "number") {
    css["min-height"] = `${node.minLines * 24}px`;
  }
  if (typeof node.maxLines === "number") {
    css["max-height"] = `${node.maxLines * 24}px`;
    css.overflow = "hidden";
  }
  return css;
}

/**
 * A Material field's label sits inside an empty field with no placeholder (fieldValue draws it
 * there); once the field holds a value or shows a placeholder, the label floats above it.
 */
function floatingLabel(node: Raw, empty: boolean, scope: WebRenderScope): WebElement[] {
  if (typeof node.label !== "string" || (empty && node.placeholder === undefined)) {
    return [];
  }
  return [
    el(
      "span",
      { attrs: { "data-slot": "label" }, style: { "font-size": "12px", opacity: "0.8" } },
      [bound(node.label, scope)],
    ),
  ];
}

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

function splitParentFacing(
  style: Record<string, string>,
): [Record<string, string>, Record<string, string>] {
  const outer: Record<string, string> = {};
  const inner: Record<string, string> = {};
  for (const [key, value] of Object.entries(style)) {
    (PARENT_FACING.has(key) ? outer : inner)[key] = value;
  }
  return [outer, inner];
}

/** As on the devices: a decidable error shows errorText, else the supporting text. */
function fieldCaption(node: Raw, error: boolean, scope: WebRenderScope): WebElement[] {
  const caption = error ? (node.errorText ?? node.supportingText) : node.supportingText;
  if (typeof caption !== "string") {
    return [];
  }
  const color = cssColor(error ? "error" : "onSurfaceVariant", scope.style);
  return [
    el(
      "span",
      {
        attrs: error ? { role: "alert" } : {},
        style: { "font-size": "12px", padding: "0 16px", ...(color ? { color } : {}) },
      },
      [bound(caption, scope)],
    ),
  ];
}

const textField: NodeRenderer = (node, scope, path) => {
  const { shown, empty } = fieldValue(node, scope);
  const error =
    node.errorWhen !== undefined && decide(node.errorWhen, presentation(scope)) === true;
  const disabled = disabledState(node, scope);
  const { attrs, style } = base(node, scope, {
    display: "flex",
    "align-items": "center",
    "min-height": "56px",
    padding: "0 16px",
    gap: "12px",
    ...fieldChrome(node, error, scope),
    ...(empty ? { opacity: "0.7" } : {}),
    ...disabled.css,
  });
  const caption = fieldCaption(node, error, scope);
  // With a caption, the wrapper is what the parent lays out, so it takes the field's sizing.
  const [outer, inner] = caption.length === 0 ? [{}, style] : splitParentFacing(style);
  const box = el("div", { attrs: { ...attrs, role: "textbox", ...disabled.attrs }, style: inner }, [
    ...namedIcon(node.leadingIcon, scope),
    el("span", { style: { display: "flex", "flex-direction": "column", flex: "1 1 auto" } }, [
      ...floatingLabel(node, empty, scope),
      el("span", { style: lineBounds(node) }, [shown]),
    ]),
    // The trailing slot is an {icon, label} action, like an app-bar action.
    ...appBarIcons([node.trailingIcon], scope, path),
  ]);
  const field = caption.length === 0 ? box : withOverContentLayers(box, node.style, scope.style);
  return caption.length === 0
    ? field
    : el("div", { style: { ...outer, display: "flex", "flex-direction": "column", gap: "4px" } }, [
        field,
        ...caption,
      ]);
};

/**
 * Material text-field chrome. `filled` (the native default) is a tinted container with a bottom
 * indicator; `outlined` is a full outline. Either turns to the error colour on a decidable error.
 */
function fieldChrome(node: Raw, error: boolean, scope: WebRenderScope): Record<string, string> {
  if (node.variant === "outlined") {
    const outline = cssColor(error ? "error" : "outline", scope.style) ?? "currentColor";
    return { "border-radius": "4px", border: `1px solid ${outline}` };
  }
  const indicator = cssColor(error ? "error" : "onSurfaceVariant", scope.style) ?? "currentColor";
  const container = cssColor("surfaceContainerHighest", scope.style);
  return {
    "border-radius": "4px 4px 0 0",
    "border-bottom": `1px solid ${indicator}`,
    ...(container ? { "background-color": container } : {}),
  };
}

/**
 * A Material 3 switch: a 52x32 track with a thumb at the end when on (24 px, onPrimary on primary)
 * and at the start when off (16 px, outline on surfaceContainerHighest inside an outline border).
 */
function switchMark(on: boolean, scope: WebRenderScope): WebElement {
  const outline = cssColor("outline", scope.style) ?? "currentColor";
  const thumb = el("span", {
    attrs: { "data-part": "thumb" },
    style: {
      width: on ? "24px" : "16px",
      height: on ? "24px" : "16px",
      "border-radius": "50%",
      "background-color": on ? (cssColor("onPrimary", scope.style) ?? "#fff") : outline,
      ...(on ? { "margin-inline-start": "auto" } : {}),
    },
  });
  return el(
    "span",
    {
      style: {
        display: "flex",
        "align-items": "center",
        "box-sizing": "border-box",
        width: "52px",
        height: "32px",
        padding: on ? "0 4px" : "0 6px",
        "border-radius": "16px",
        "flex-shrink": "0",
        border: `2px solid ${on ? "transparent" : outline}`,
        ...roleCss(scope, on ? "primary" : "surfaceContainerHighest", "onPrimary"),
      },
    },
    [thumb],
  );
}

/** A switch track or checkbox box, drawn from whether its state is on. */
function toggleMark(role: "switch" | "checkbox", on: boolean, scope: WebRenderScope): WebElement {
  return role === "switch"
    ? switchMark(on, scope)
    : el("span", {
        style: {
          width: "18px",
          height: "18px",
          "border-radius": "2px",
          "flex-shrink": "0",
          border: `2px solid ${cssColor(on ? "primary" : "onSurfaceVariant", scope.style) ?? "currentColor"}`,
          ...(on ? roleCss(scope, "primary", "onPrimary") : {}),
        },
      });
}

/** Whether a toggle's state key, with repeat placeholders bound first, holds `true`. */
function isOn(stateKey: unknown, scope: WebRenderScope): boolean {
  const key = typeof stateKey === "string" ? bound(stateKey, scope) : undefined;
  return key !== undefined && scope.condition.state[key] === true;
}

const toggle =
  (role: "switch" | "checkbox"): NodeRenderer =>
  (node, scope) => {
    const on = isOn(node.stateKey, scope);
    const disabled = disabledState(node, scope);
    const { attrs, style } = base(node, scope, {
      display: "flex",
      "align-items": "center",
      gap: "12px",
      "min-height": "48px",
      ...disabled.css,
    });
    const semantics = { ...attrs, role, "aria-checked": String(on), ...disabled.attrs };
    const label = typeof node.label === "string" ? [bound(node.label, scope)] : [];
    const mark = toggleMark(role, on, scope);
    // As on both devices, a switch's label leads its track and a checkbox's box leads its label.
    return el(
      "div",
      { attrs: semantics, style },
      role === "switch" ? [...label, mark] : [mark, ...label],
    );
  };

const card: NodeRenderer = (raw, scope, path) => {
  // A card hugs its content, but grows like a line around a child that fills.
  const node = filling(raw, lineFillAxes(raw, scope, path));
  const { attrs, style } = base(node, scope, {
    display: "flex",
    "flex-direction": "column",
    // Material's ColumnScope keeps wrap-sized content at its own width.
    "align-items": "flex-start",
    "border-radius": "12px",
    ...roleCss(
      scope,
      node.variant === "outlined" ? "surface" : "surfaceContainerHighest",
      "onSurface",
    ),
  });
  const cardStyle = { ...scope.style, parentAxis: "column" as const, weightsChildren: true };
  const inner = child(scope, { inBox: false, style: cardStyle });
  return el("div", { attrs, style }, children(node, inner, path));
};

/** A list item's trailing switch, checkbox or icon, drawn from spec state. */
/** An icon slot named by an icon name, drawn with the icon placeholder; nothing when absent. */
function namedIcon(name: unknown, scope: WebRenderScope): WebElement[] {
  return typeof name === "string" ? [icon({ type: "icon", name }, scope, "")] : [];
}

function trailing(
  node: Raw,
  scope: WebRenderScope,
  disabledAttrs: Record<string, string>,
): WebChild[] {
  const entry = record(node.trailing);
  if (entry?.type === "switch" || entry?.type === "checkbox") {
    const on = isOn(entry.stateKey, scope);
    return [
      el(
        "span",
        {
          // A disabled list item disables its trailing control too.
          attrs: { role: entry.type, "aria-checked": String(on), ...disabledAttrs },
          style: { display: "flex" },
        },
        [toggleMark(entry.type, on, scope)],
      ),
    ];
  }
  if (entry?.type === "icon") {
    return [icon({ type: "icon", name: entry.name }, scope, "")];
  }
  return [];
}

const listItem: NodeRenderer = (node, scope) => {
  const disabled = disabledState(node, scope);
  const { attrs, style } = base(node, scope, {
    display: "flex",
    "align-items": "center",
    gap: "16px",
    "min-height": "56px",
    padding: "8px 16px",
    "align-self": "stretch",
    ...disabled.css,
  });
  const supporting =
    node.supporting === undefined
      ? []
      : [
          el("span", { style: { "font-size": "14px", opacity: "0.7" } }, [
            bound(node.supporting, scope),
          ]),
        ];
  const texts = el(
    "div",
    { style: { display: "flex", "flex-direction": "column", flex: "1 1 auto" } },
    [el("span", { style: { "font-size": "16px" } }, [bound(node.headline, scope)]), ...supporting],
  );
  return el("div", { attrs: { ...attrs, role: "listitem", ...disabled.attrs }, style }, [
    ...namedIcon(node.leadingIcon, scope),
    texts,
    ...trailing(node, scope, disabled.attrs),
  ]);
};

const KIT: WebRenderKit = {
  base,
  child,
  children,
  bound,
  icon,
  roleCss,
  disabledState,
  renderNode: renderWebNode,
  safeAreaEdges,
};

export const WEB_NODE_RENDERERS: Readonly<Record<string, NodeRenderer>> = {
  box,
  row: line("row"),
  column: line("column"),
  scroll,
  text,
  spacer,
  divider,
  icon,
  image,
  button,
  topAppBar,
  textField,
  switch: toggle("switch"),
  checkbox: toggle("checkbox"),
  card,
  listItem,
  ...webCollectionRenderers(KIT),
  ...webControlRenderers(KIT),
  ...webMediaRenderers(KIT),
  ...webMapRenderers(KIT),
  ...webStackRenderers(KIT),
};

const WEB_LAYER_RENDERERS = webSheetLayers(KIT);

function placeholder(node: Raw, scope: WebRenderScope, path: string): WebElement {
  const type = String(node.type);
  const id = typeof node.id === "string" ? node.id : undefined;
  scope.unsupported.push({ type, ...(id ? { id } : {}), path, reason: "unsupportedType" });
  const { attrs, style } = base(node, scope, {
    border: "1px dashed currentColor",
    padding: "4px",
    "font-size": "11px",
    opacity: "0.7",
  });
  return el("div", { attrs: { ...attrs, "data-unsupported": type }, style }, [
    id ? `${type} #${id}` : type,
  ]);
}

/** One node and its subtree, or undefined when its `visibleWhen` does not hold. */
/**
 * Binds a repeat instance into a node's conditions, typed operands and state keys, through the
 * devices' own field walk. Text fields are left for `bound()`, so each text binds exactly once, in
 * the device order (data, then repeat items, then state). Actions never run in a still, so their
 * emit bindings stay as authored.
 */
function bindStructure(node: Raw, path: string, instance: Instance): Raw {
  return mapBindableFields(node, path, (value, _at, kind) => {
    if (kind === "text" || typeof value !== "string") {
      return value;
    }
    return kind === "operand" ? bindTyped(value, instance) : bindText(value, instance);
  });
}

/** The scope every condition reads: spec state with any pager locals over it. */
function presentation(scope: WebRenderScope): ConditionScope {
  return scope.textLocals
    ? { ...scope.condition, state: { ...scope.condition.state, ...scope.textLocals } }
    : scope.condition;
}

/**
 * The node's style with every `styleWhen` entry whose condition holds merged over it in authored
 * order, as the devices resolve it. An entry the still cannot decide is not applied.
 */
function resolvedStyle(node: Raw, scope: WebRenderScope): Raw | undefined {
  const entries = Array.isArray(node.styleWhen) ? node.styleWhen : [];
  return entries.reduce<Raw | undefined>((style, entry) => {
    const when = record(entry);
    return when && decide(when.when, presentation(scope)) === true
      ? { ...style, ...record(when.style) }
      : style;
  }, record(node.style));
}

/**
 * What rendering and parent fill inference both see of a node: its repeat placeholders bound
 * (through the devices' own contract), a pager's locals set before its own conditions run, its
 * `visibleWhen` (undefined when hidden) and its `styleWhen` merged. One path, so the two agree.
 */
function preparedNode(
  node: unknown,
  scope: WebRenderScope,
  path: string,
): { styled: Raw; scope: WebRenderScope } | undefined {
  const authored = record(node);
  if (!authored || typeof authored.type !== "string") {
    return undefined;
  }
  const raw = scope.instances.reduce(
    (current, instance) => bindStructure(current, path, instance),
    authored,
  );
  const local = withPagerLocals(raw, scope, KIT);
  if (raw.visibleWhen !== undefined && !conditionHolds(raw.visibleWhen, presentation(local))) {
    return undefined;
  }
  return { styled: { ...raw, style: resolvedStyle(raw, local) }, scope: local };
}

export function renderWebNode(
  node: unknown,
  scope: WebRenderScope,
  path: string,
): WebElement | undefined {
  const prepared = preparedNode(node, scope, path);
  if (!prepared) {
    return undefined;
  }
  const { styled, scope: local } = prepared;
  const own: WebRenderScope = { ...local, ownInsets: safeAreaEdges(styled) };
  const layer = WEB_LAYER_RENDERERS[String(styled.type)];
  if (layer) {
    layer(styled, own, path);
    return undefined;
  }
  const renderer = WEB_NODE_RENDERERS[String(styled.type)];
  const element = renderer ? renderer(styled, own, path) : placeholder(styled, own, path);
  const shaded = shaderFallback(styled, path);
  if (shaded) {
    own.unsupported.push(shaded);
  }
  // The layers belong to the node's own box; a wrapper (a captioned field) layers its box itself.
  return element.attrs["data-node"] === undefined
    ? element
    : withOverContentLayers(element, styled.style, own.style);
}
