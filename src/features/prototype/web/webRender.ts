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
import { conditionHolds, decide, type ConditionScope } from "./webCondition";
import { el, type WebChild, type WebElement } from "./webNodes";
import {
  boxLayoutCss,
  cssColor,
  lineCss,
  nodeCss,
  textCss,
  type WebStyleContext,
} from "./webStyle";

/** A node the web renderer drew as a labelled placeholder instead of its real content. */
export interface UnsupportedWebNode {
  readonly type: string;
  readonly id?: string;
  readonly path: string;
  readonly reason: "unsupportedType" | "assetNotInlined";
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
  /** Safe-area edges an ancestor already applied. */
  readonly consumedInsets?: readonly string[];
  /** Safe-area edges the node being rendered applies, consumed for its descendants. */
  readonly ownInsets?: readonly string[];
}

type NodeRenderer = (node: Raw, scope: WebRenderScope, path: string) => WebElement;

/** Repeat expansion is bounded so one spec cannot produce an unbounded page. */
const MAX_WEB_REPEAT_ITEMS = 200;

/** Bare `{key}` placeholders read spec state, then top-level derived values; others stay literal. */
/** `{key}` reads state; `{derived:name}` reads a top-level derived value, as on the devices. */
function bindBare(text: string, scope: WebRenderScope): string {
  return text.replace(/\{([^{}]+)\}/g, (whole, inner: string) => {
    if (!inner.startsWith("derived:")) {
      return Object.hasOwn(scope.condition.state, inner)
        ? renderScalar(scope.condition.state[inner])
        : whole;
    }
    const name = inner.slice("derived:".length);
    const derive = record(scope.spec.derive);
    return derive && Object.hasOwn(derive, name)
      ? resolvePrototypeDerived(scope.spec as Parameters<typeof resolvePrototypeDerived>[0], name, {
          data: scope.data,
          state: scope.condition.state,
          env: scope.format,
        })
      : whole;
  });
}

export function bound(text: unknown, scope: WebRenderScope): string {
  if (typeof text !== "string") {
    return "";
  }
  // Data placeholders bind first, then repeat items, then state, as the devices bind text. Every
  // inserted value is shielded until the end, so it is never read again as a placeholder.
  const data = bindPrototypeDataText(text, (pointer) => {
    const value = resolvePrototypeDataPointer(scope.data, pointer);
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? shield(renderScalar(value))
      : "";
  });
  const items = [...scope.instances]
    .reverse()
    .reduce((value, instance) => bindText(value, shieldedInstance(instance)), data);
  return unshield(bindBare(items, scope));
}

/** Braces in an inserted value become private-use stand-ins until binding is done. */
const OPEN = "\uE000";
const CLOSE = "\uE001";
const shield = (value: string) => value.replaceAll("{", OPEN).replaceAll("}", CLOSE);
const unshield = (value: string) => value.replaceAll(OPEN, "{").replaceAll(CLOSE, "}");

function shieldedInstance(instance: Instance): Instance {
  const values = Object.fromEntries(
    Object.entries(instance.values).map(([key, value]) => [
      key,
      typeof value === "string" ? shield(value) : value,
    ]),
  );
  return { ...instance, values };
}

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
function safeAreaCss(
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
 * A repeat's rows: a literal array or a pointer into the spec's data. As on the devices, only
 * object items repeat (scalars are skipped before indices are assigned), up to the item cap.
 */
function repeatRows(repeat: Raw, scope: WebRenderScope): unknown[] {
  const itemsPath = record(repeat.items)?.path;
  const items = Array.isArray(repeat.items)
    ? repeat.items
    : typeof itemsPath === "string"
      ? resolvePrototypeDataPointer(scope.data, itemsPath)
      : undefined;
  const rows = Array.isArray(items) ? items.filter((item) => record(item) !== undefined) : [];
  return rows.slice(0, MAX_WEB_REPEAT_ITEMS);
}

function children(node: Raw, scope: WebRenderScope, path: string): WebChild[] {
  const list = Array.isArray(node.children) ? node.children : [];
  const repeat = record(node.repeat);
  if (!repeat) {
    return list.flatMap((entry, index) => renderOrSkip(entry, scope, `${path}.children[${index}]`));
  }
  const rows = repeatRows(repeat, scope);
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
    return list.flatMap((entry, at) => renderOrSkip(entry, itemScope, `${path}.children[${at}]`));
  });
}

function renderOrSkip(node: unknown, scope: WebRenderScope, path: string): WebChild[] {
  const rendered = renderWebNode(node, scope, path);
  return rendered ? [rendered] : [];
}

/** A spacer with no width, height or weight fills its parent, as the native spacer does. */
function isUnsizedSpacer(node: unknown): boolean {
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
  const style = record(node.style) ?? {};
  return { ...node, style: { width: "fill", height: "fill", ...style } };
}

/**
 * Whether a child is a visible spacer that will fill its line: its repeat placeholders bind, its
 * visibleWhen keeps it, and its style (with matching styleWhen entries) leaves it unsized.
 */
function fillsAsSpacer(entry: unknown, scope: WebRenderScope, path: string): boolean {
  const bound = scope.instances.reduce(
    (current, instance) => bindStructure(current, path, instance),
    record(entry) ?? {},
  );
  if (bound.visibleWhen !== undefined && !conditionHolds(bound.visibleWhen, scope.condition)) {
    return false;
  }
  return isUnsizedSpacer({ ...bound, style: resolvedStyle(bound, scope) });
}

/** A line grows when it renders a filling spacer; a repeat with no rows renders none. */
function lineFills(raw: Raw, scope: WebRenderScope, path: string): boolean {
  const repeat = record(raw.repeat);
  if (!Array.isArray(raw.children) || (repeat && repeatRows(repeat, scope).length === 0)) {
    return false;
  }
  return raw.children.some((entry) => fillsAsSpacer(entry, scope, path));
}

function spacerFilled(node: Raw): Raw {
  return isUnsizedSpacer(node) ? fillMissing(node) : node;
}

const line =
  (axis: "row" | "column"): NodeRenderer =>
  (raw, scope, path) => {
    // A wrap-sized line around a filling spacer grows to its parent, as a Compose parent does
    // around a fillMaxSize child; otherwise it would shrink to nothing.
    const node = lineFills(raw, scope, path) ? fillMissing(raw) : raw;
    const { attrs, style } = base(node, scope, lineCss(axis, node.style));
    const inner = child(scope, { inBox: false, style: { ...scope.style, parentAxis: axis } });
    return el("div", { attrs, style }, children(node, inner, path));
  };

const box: NodeRenderer = (node, scope, path) => {
  const { attrs, style } = base(node, scope, boxLayoutCss(node.style));
  const inner = child(scope, { inBox: true, style: { ...scope.style, parentAxis: undefined } });
  return el("div", { attrs, style }, children(node, inner, path));
};

/** A text node's content: its `text`, or each span with its own text style. */
function textContent(node: Raw, scope: WebRenderScope): WebChild[] {
  if (!Array.isArray(node.spans)) {
    return [bound(node.text, scope)];
  }
  return node.spans.map((span) => {
    const entry = record(span) ?? {};
    const style = record(entry.style);
    const background = cssColor(style?.background, scope.style);
    const css = {
      ...textCss(style, scope.style),
      ...(background ? { "background-color": background } : {}),
    };
    return el("span", { style: css }, [bound(entry.text, scope)]);
  });
}

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
  return el("span", { attrs, style }, textContent(node, scope));
};

const stack: NodeRenderer = (node, scope, path) => {
  const screens = record(node.screens) ?? {};
  const start = typeof node.start === "string" ? node.start : Object.keys(screens)[0];
  const { attrs, style } = base(node, scope, { display: "flex", "flex-direction": "column" });
  const inner = child(scope, { inBox: false, style: { ...scope.style, parentAxis: "column" } });
  const screen = start === undefined ? undefined : screens[start];
  const content = renderWebNode(screen, inner, `${path}.screens[${JSON.stringify(start)}]`);
  // A stack screen fills the stack, as on both devices.
  const filled = content
    ? [
        {
          ...content,
          style: { ...content.style, flex: "1 1 auto", "min-height": "0", "align-self": "stretch" },
        },
      ]
    : [];
  return el("div", { attrs, style }, filled);
};

const scroll: NodeRenderer = (node, scope, path) => {
  const horizontal = node.axis === "horizontal";
  const { attrs, style } = base(node, scope, {
    display: "flex",
    // A reverse scroll starts at its end, as reverseScrolling does; its one child keeps its order.
    "flex-direction": `${horizontal ? "row" : "column"}${node.reverse === true ? "-reverse" : ""}`,
    // Like the native start-aligned Box, wrap-sized content keeps its own cross-axis size.
    "align-items": "flex-start",
    [horizontal ? "overflow-x" : "overflow-y"]: "auto",
  });
  const inner = child(scope, {
    inBox: false,
    style: { ...scope.style, parentAxis: horizontal ? "row" : "column" },
  });
  return el("div", { attrs, style }, renderOrSkip(node.child, inner, `${path}.child`));
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

const icon: NodeRenderer = (node, scope) => {
  // The Material glyph set is not inlined, so an icon draws as a tinted shape titled with its name.
  const { attrs, style } = base(node, scope, {
    display: "inline-block",
    width: "24px",
    height: "24px",
    "border-radius": "6px",
    "background-color": "currentColor",
    opacity: "0.6",
    "flex-shrink": "0",
  });
  return el("span", { attrs: { ...attrs, title: String(node.name ?? ""), role: "img" }, style });
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
    node.enabledWhen === undefined || conditionHolds(node.enabledWhen, scope.condition);
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
  const error = node.errorWhen !== undefined && decide(node.errorWhen, scope.condition) === true;
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
  const field = el(
    "div",
    { attrs: { ...attrs, role: "textbox", ...disabled.attrs }, style: inner },
    [
      ...namedIcon(node.leadingIcon, scope),
      el("span", { style: { display: "flex", "flex-direction": "column", flex: "1 1 auto" } }, [
        ...floatingLabel(node, empty, scope),
        el("span", { style: lineBounds(node) }, [shown]),
      ]),
      // The trailing slot is an {icon, label} action, like an app-bar action.
      ...appBarIcons([node.trailingIcon], scope, path),
    ],
  );
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

/** A switch track or checkbox box, drawn from whether its state is on. */
function toggleMark(role: "switch" | "checkbox", on: boolean, scope: WebRenderScope): WebElement {
  return role === "switch"
    ? el("span", {
        style: {
          width: "52px",
          height: "32px",
          "border-radius": "16px",
          "flex-shrink": "0",
          ...roleCss(scope, on ? "primary" : "surfaceContainerHighest", "onPrimary"),
        },
      })
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
    return el("div", { attrs: semantics, style }, [
      bound(node.label, scope),
      toggleMark(role, on, scope),
    ]);
  };

const card: NodeRenderer = (node, scope, path) => {
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
  const inner = child(scope, { inBox: false, style: { ...scope.style, parentAxis: "column" } });
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

export const WEB_NODE_RENDERERS: Readonly<Record<string, NodeRenderer>> = {
  box,
  row: line("row"),
  column: line("column"),
  stack,
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
};

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

/**
 * The node's style with every `styleWhen` entry whose condition holds merged over it in authored
 * order, as the devices resolve it. An entry the still cannot decide is not applied.
 */
function resolvedStyle(node: Raw, scope: WebRenderScope): Raw | undefined {
  const entries = Array.isArray(node.styleWhen) ? node.styleWhen : [];
  return entries.reduce<Raw | undefined>((style, entry) => {
    const when = record(entry);
    return when && decide(when.when, scope.condition) === true
      ? { ...style, ...record(when.style) }
      : style;
  }, record(node.style));
}

export function renderWebNode(
  node: unknown,
  scope: WebRenderScope,
  path: string,
): WebElement | undefined {
  const authored = record(node);
  if (!authored || typeof authored.type !== "string") {
    return undefined;
  }
  // Repeat placeholders bind through the same contract the devices use: text, spans, nested
  // conditions with typed operands, and state keys.
  const raw = scope.instances.reduce(
    (current, instance) => bindStructure(current, path, instance),
    authored,
  );
  if (raw.visibleWhen !== undefined && !conditionHolds(raw.visibleWhen, scope.condition)) {
    return undefined;
  }
  const styled: Raw = { ...raw, style: resolvedStyle(raw, scope) };
  const own: WebRenderScope = { ...scope, ownInsets: safeAreaEdges(styled) };
  const renderer = WEB_NODE_RENDERERS[String(styled.type)];
  return renderer ? renderer(styled, own, path) : placeholder(styled, own, path);
}
