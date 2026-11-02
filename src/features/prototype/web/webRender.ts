import { bindPrototypeDataText, resolvePrototypeDataPointer } from "../prototypeData";
import {
  projectPrototypeDerivedItem,
  resolvePrototypeDerived,
  type PrototypeFormatEnvironment,
} from "../prototypeFormat";
import {
  bindNodeFields,
  bindText,
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
  // Data placeholders bind first, then repeat items, then state, as the devices bind text.
  const data = bindPrototypeDataText(text, (pointer) => {
    const value = resolvePrototypeDataPointer(scope.data, pointer);
    return typeof value === "string" || typeof value === "number" || typeof value === "boolean"
      ? renderScalar(value)
      : "";
  });
  const items = [...scope.instances]
    .reverse()
    .reduce((value, instance) => bindText(value, instance), data);
  return bindBare(items, scope);
}

const SAFE_AREA_EDGES: Readonly<Record<string, [string, string]>> = {
  top: ["padding-top", "--safe-top"],
  bottom: ["padding-bottom", "--safe-bottom"],
  start: ["padding-inline-start", "--safe-left"],
  end: ["padding-inline-end", "--safe-right"],
};

/**
 * `safeAreaPadding` adds the frame's inset on each named edge to the node's own padding. System
 * bars and the cutout both read the frame's safe area; the still has no keyboard, so `ime` adds
 * nothing.
 */
function safeAreaCss(node: Raw, css: Record<string, string>): Record<string, string> {
  const safe = record(node.safeAreaPadding);
  const types = Array.isArray(safe?.types) ? safe.types : [];
  if (!safe || !Array.isArray(safe.edges) || !types.some((type) => type !== "ime")) {
    return css;
  }
  const padded = { ...css };
  for (const edge of safe.edges) {
    const target = SAFE_AREA_EDGES[String(edge)];
    if (target) {
      padded[target[0]] = `calc(${css[target[0]] ?? "0px"} + var(${target[1]}))`;
    }
  }
  return padded;
}

function base(node: Raw, scope: WebRenderScope, extra: Record<string, string> = {}) {
  const attrs: Record<string, string> = { "data-node": String(node.type) };
  if (typeof node.testTag === "string") {
    attrs["data-testid"] = node.testTag;
  }
  if (typeof node.contentDescription === "string") {
    attrs["aria-label"] = bound(node.contentDescription, scope);
  }
  // Component defaults first, so the spec's own style wins, as on both devices.
  const style = {
    ...extra,
    ...nodeCss(node.style, scope.style),
    ...textCss(record(node.style), scope.style),
    ...(scope.inBox ? { "grid-area": "cell" } : {}),
  };
  return { attrs, style: safeAreaCss(node, style) };
}

function child(scope: WebRenderScope, patch: Partial<WebRenderScope>): WebRenderScope {
  return { ...scope, ...patch, style: { ...scope.style, ...patch.style } };
}

function children(node: Raw, scope: WebRenderScope, path: string): WebChild[] {
  const list = Array.isArray(node.children) ? node.children : [];
  const repeat = record(node.repeat);
  if (!repeat) {
    return list.flatMap((entry, index) => renderOrSkip(entry, scope, `${path}.children[${index}]`));
  }
  // Items are a literal array or a pointer into the spec's data.
  const itemsPath = record(repeat.items)?.path;
  const items = Array.isArray(repeat.items)
    ? repeat.items
    : typeof itemsPath === "string"
      ? resolvePrototypeDataPointer(scope.data, itemsPath)
      : undefined;
  const alias = typeof repeat.as === "string" ? repeat.as : "item";
  const derive = record(repeat.derive) as
    | Parameters<typeof projectPrototypeDerivedItem>[0]
    | undefined;
  return (Array.isArray(items) ? items.slice(0, MAX_WEB_REPEAT_ITEMS) : []).flatMap(
    (item, index) => {
      const values = record(item) ?? {};
      const instance: Instance = {
        binding: { alias, index: true },
        values: derive ? projectPrototypeDerivedItem(derive, values, scope.format) : values,
        index,
      };
      const itemScope = child(scope, { instances: [...scope.instances, instance] });
      return list.flatMap((entry, at) => renderOrSkip(entry, itemScope, `${path}.children[${at}]`));
    },
  );
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

function spacerFilled(node: Raw): Raw {
  return isUnsizedSpacer(node) ? fillMissing(node) : node;
}

const line =
  (axis: "row" | "column"): NodeRenderer =>
  (raw, scope, path) => {
    // A wrap-sized line around a filling spacer grows to its parent, as a Compose parent does
    // around a fillMaxSize child; otherwise it would shrink to nothing.
    const node =
      Array.isArray(raw.children) && raw.children.some(isUnsizedSpacer) ? fillMissing(raw) : raw;
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
    return el("span", { style: textCss(record(entry.style), scope.style) }, [
      bound(entry.text, scope),
    ]);
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
    "flex-direction": horizontal ? "row" : "column",
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
  const color = cssColor("outlineVariant", scope.style) ?? "rgba(0,0,0,0.12)";
  return el(
    "div",
    base(
      node,
      scope,
      vertical
        ? { width: "1px", "align-self": "stretch", "background-color": color }
        : { height: "1px", "align-self": "stretch", "background-color": color },
    ),
  );
};

const icon: NodeRenderer = (node, scope) => {
  // The Material glyph set is not inlined, so an icon draws as a tinted shape titled with its name.
  const { attrs, style } = base(node, scope, {
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

const button: NodeRenderer = (node, scope) => {
  const enabled =
    node.enabledWhen === undefined || conditionHolds(node.enabledWhen, scope.condition);
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
    ...outline,
    // A button whose enabledWhen is decidably false draws disabled, as the native button does.
    ...(enabled ? {} : { opacity: "0.38" }),
  });
  const role = { ...attrs, role: "button", ...(enabled ? {} : { "aria-disabled": "true" }) };
  return el("div", { attrs: role, style }, [bound(node.label, scope)]);
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

const topAppBar: NodeRenderer = (node, scope, path) => {
  const { attrs, style } = base(node, scope, {
    display: "flex",
    "align-items": "center",
    // Like the native bar, it takes no window insets of its own: status-bar clearance comes only
    // from an authored safeAreaPadding.
    "min-height": "64px",
    "padding-inline": "16px",
    "font-size": "22px",
    "align-self": "stretch",
    ...roleCss(scope, "surface", "onSurface"),
  });
  const actions = Array.isArray(node.actions) ? node.actions : [];
  const title = el("span", { style: { flex: "1 1 auto" } }, [bound(node.title, scope)]);
  return el("div", { attrs: { ...attrs, role: "heading" }, style }, [
    ...appBarIcons([node.navigationIcon], scope, path),
    title,
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

const textField: NodeRenderer = (node, scope) => {
  const { shown, empty } = fieldValue(node, scope);
  const error = node.errorWhen !== undefined && decide(node.errorWhen, scope.condition) === true;
  const { attrs, style } = base(node, scope, {
    display: "flex",
    "align-items": "center",
    "min-height": "56px",
    padding: "0 16px",
    "border-radius": "4px",
    border: `1px solid ${cssColor(error ? "error" : "outline", scope.style) ?? "currentColor"}`,
    ...(empty ? { opacity: "0.7" } : {}),
  });
  const field = el("div", { attrs: { ...attrs, role: "textbox" }, style }, [shown]);
  const caption = fieldCaption(node, error, scope);
  return caption.length === 0
    ? field
    : el("div", { style: { display: "flex", "flex-direction": "column", gap: "4px" } }, [
        field,
        ...caption,
      ]);
};

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
    const { attrs, style } = base(node, scope, {
      display: "flex",
      "align-items": "center",
      gap: "12px",
      "min-height": "48px",
    });
    return el("div", { attrs: { ...attrs, role, "aria-checked": String(on) }, style }, [
      bound(node.label, scope),
      toggleMark(role, on, scope),
    ]);
  };

const card: NodeRenderer = (node, scope, path) => {
  const { attrs, style } = base(node, scope, {
    display: "flex",
    "flex-direction": "column",
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
function trailing(node: Raw, scope: WebRenderScope): WebChild[] {
  const entry = record(node.trailing);
  if (entry?.type === "switch" || entry?.type === "checkbox") {
    const on = isOn(entry.stateKey, scope);
    return [
      el(
        "span",
        { attrs: { role: entry.type, "aria-checked": String(on) }, style: { display: "flex" } },
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
  const { attrs, style } = base(node, scope, {
    display: "flex",
    "align-items": "center",
    gap: "16px",
    "min-height": "56px",
    padding: "8px 16px",
    "align-self": "stretch",
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
  return el("div", { attrs: { ...attrs, role: "listitem" }, style }, [
    texts,
    ...trailing(node, scope),
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
    (current, instance) => bindNodeFields(current, path, instance),
    authored,
  );
  if (raw.visibleWhen !== undefined && !conditionHolds(raw.visibleWhen, scope.condition)) {
    return undefined;
  }
  const styled: Raw = { ...raw, style: resolvedStyle(raw, scope) };
  const renderer = WEB_NODE_RENDERERS[String(styled.type)];
  return renderer ? renderer(styled, scope, path) : placeholder(styled, scope, path);
}
