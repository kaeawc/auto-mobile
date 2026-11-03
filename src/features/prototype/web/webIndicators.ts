import { record, type Raw } from "../prototypeTemplate";
import { el, type WebChild, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import { cssColor, lineCss, textCss } from "./webStyle";

type Css = Record<string, string>;

const px = (value: number): string => `${Number(value.toFixed(3))}px`;
const dp = (value: unknown): number =>
  typeof value === "number" && Number.isFinite(value) ? Math.max(0, value) : 0;

/** A colour role, or currentColor when the palette has no such role. */
function role(name: string, scope: WebRenderScope): string {
  return cssColor(name, scope.style) ?? "currentColor";
}

/** The icon placeholder at a size other than its default 24 px. */
function sizedIcon(name: unknown, size: number, scope: WebRenderScope, kit: WebRenderKit) {
  const glyph = kit.icon({ type: "icon", name }, scope, "");
  return { ...glyph, style: { ...glyph.style, width: px(size), height: px(size) } };
}

/**
 * A Material 3 badge: a 6 dp error dot without text, or a 16 dp error pill around its label-small
 * text, as Android's `Badge` draws it.
 */
const badgeRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const label = typeof node.text === "string" ? kit.bound(node.text, scope) : "";
    const shape: Css = label
      ? {
          "min-width": "16px",
          height: "16px",
          padding: "0 4px",
          "box-sizing": "border-box",
          ...textCss({ textStyle: "labelSmall" }, scope.style),
        }
      : { width: "6px", height: "6px" };
    const { attrs, style } = kit.base(node, scope, {
      display: "inline-flex",
      "align-items": "center",
      "justify-content": "center",
      "border-radius": "999px",
      "flex-shrink": "0",
      ...kit.roleCss(scope, "error", "onError"),
      ...shape,
    });
    return el("span", { attrs: { ...attrs, "data-badge": label ? "large" : "small" }, style }, [
      label,
    ]);
  };

/** Where an indeterminate indicator is drawn in a still: a fixed 30 % arc or segment. */
export const INDETERMINATE_STILL_FRACTION = 0.3;

/**
 * A progress indicator's drawn fraction: the bound state value over `max` (default 1), clamped to
 * 0..1, as Android draws it. Unbound, it is indeterminate (undefined).
 */
export function progressFraction(node: Raw, scope: WebRenderScope, kit: WebRenderKit) {
  if (typeof node.stateKey !== "string") {
    return undefined;
  }
  const value = scope.condition.state[kit.bound(node.stateKey, scope)];
  const max = typeof node.max === "number" && node.max !== 0 ? node.max : 1;
  const ratio = (typeof value === "number" && Number.isFinite(value) ? value : 0) / max;
  return Math.min(Math.max(Number.isFinite(ratio) ? ratio : 0, 0), 1);
}

const percent = (fraction: number) => `${Number((fraction * 100).toFixed(3))}%`;

function linearProgress(fraction: number, scope: WebRenderScope): WebChild[] {
  return [
    el("span", {
      attrs: { "data-part": "indicator" },
      style: {
        display: "block",
        width: percent(fraction),
        height: "100%",
        "border-radius": "2px",
        "background-color": role("primary", scope),
      },
    }),
  ];
}

/** A 40 dp ring with a 4 dp stroke: the track, then the indicator arc from twelve o'clock. */
function circularProgress(fraction: number, scope: WebRenderScope): WebChild[] {
  const ring = (stroke: string, length: number, part: string) =>
    el("circle", {
      attrs: {
        "data-part": part,
        cx: "20",
        cy: "20",
        r: "18",
        fill: "none",
        stroke,
        "stroke-width": "4",
        "stroke-linecap": "round",
        pathlength: "100",
        "stroke-dasharray": `${Number((length * 100).toFixed(3))} 100`,
        transform: "rotate(-90 20 20)",
      },
    });
  const arcs = fraction > 0 ? [ring(role("primary", scope), fraction, "indicator")] : [];
  return [
    el(
      "svg",
      { attrs: { viewbox: "0 0 40 40", width: "40", height: "40", "aria-hidden": "true" } },
      [ring(role("secondaryContainer", scope), 1, "track"), ...arcs],
    ),
  ];
}

/**
 * A Material progress indicator: linear (240 dp by 4 dp on the secondary-container track) or
 * circular (40 dp). Bound to a number it draws `value / max` and reports it as `aria-valuenow`;
 * unbound it is indeterminate, and a still draws it resting at a 30 % arc, as Android's reduced
 * motion profile does.
 */
const progressRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const determinate = progressFraction(node, scope, kit);
    const fraction = determinate ?? INDETERMINATE_STILL_FRACTION;
    const circular = node.variant === "circular";
    const shape: Css = circular
      ? { display: "inline-flex", width: "40px", height: "40px" }
      : {
          display: "block",
          width: "240px",
          height: "4px",
          "border-radius": "2px",
          overflow: "hidden",
          "background-color": role("secondaryContainer", scope),
        };
    const { attrs, style } = kit.base(node, scope, { "flex-shrink": "0", ...shape });
    const value: Record<string, string> =
      determinate === undefined
        ? { "data-indeterminate": "true" }
        : {
            "aria-valuemin": "0",
            "aria-valuemax": "100",
            "aria-valuenow": String(Math.round(determinate * 100)),
          };
    const drawn = circular ? circularProgress(fraction, scope) : linearProgress(fraction, scope);
    return el("div", { attrs: { ...attrs, role: "progressbar", ...value }, style }, drawn);
  };

/** Material 3 FAB sizes: [container, corner radius, icon]. */
const FAB_SIZES: Readonly<Record<string, [number, number, number]>> = {
  small: [40, 12, 24],
  regular: [56, 16, 24],
  large: [96, 28, 36],
};

function fabShape(node: Raw, enabled: boolean): Css {
  if (!enabled) {
    return { padding: "16px", gap: "8px", "border-radius": "16px" };
  }
  if (typeof node.label === "string") {
    return {
      height: "56px",
      "padding-inline": "16px 20px",
      gap: "12px",
      "border-radius": "16px",
      "box-sizing": "border-box",
    };
  }
  const [size, radius] = FAB_SIZES[String(node.size)] ?? FAB_SIZES.regular!;
  return { width: px(size), height: px(size), "border-radius": px(radius) };
}

/**
 * A Material 3 floating action button on primary container: small, regular or large around its
 * icon, or extended with its label. Disabled, it draws as Android does: a 12 % on-surface container
 * with 38 % content and 16 dp padding.
 */
const fabRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const disabled = kit.disabledState(node, scope);
    const enabled = disabled.attrs["aria-disabled"] === undefined;
    const onSurface = role("onSurface", scope);
    const colors: Css = enabled
      ? kit.roleCss(scope, "primaryContainer", "onPrimaryContainer")
      : {
          "background-color": `color-mix(in srgb, ${onSurface} 12%, transparent)`,
          color: `color-mix(in srgb, ${onSurface} 38%, transparent)`,
        };
    const { attrs, style } = kit.base(node, scope, {
      display: "inline-flex",
      "align-items": "center",
      "justify-content": "center",
      "flex-shrink": "0",
      ...textCss({ textStyle: "labelLarge" }, scope.style),
      ...colors,
      ...(enabled ? { "box-shadow": "0 3px 6px rgba(0,0,0,0.3)" } : {}),
      ...fabShape(node, enabled),
    });
    const iconSize = node.size === "large" && node.label === undefined ? 36 : 24;
    const label = typeof node.label === "string" ? [kit.bound(node.label, scope)] : [];
    return el("div", { attrs: { ...attrs, role: "button", ...disabled.attrs }, style }, [
      sizedIcon(node.icon, iconSize, scope, kit),
      ...label,
    ]);
  };

/**
 * A flow places its children eagerly in lines, `spacing` apart, starting a new line `runSpacing`
 * below when the next child would overflow the width, and hugs its widest line, as Android's flow
 * layout does. Each child is an inline block with the gaps as trailing margins, which the inner
 * container cancels with negative margins, so a line wraps exactly when `used + spacing + width`
 * exceeds the width. `maxLines` clips to that many lines with a line clamp.
 */
const flowRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope, path) => {
    const style = record(node.style) ?? {};
    const gap = dp(style.spacing);
    const rowGap = dp(style.runSpacing);
    const { attrs, style: css } = kit.base(node, scope, {
      display: "block",
      width: "fit-content",
      "max-width": "100%",
      overflow: "hidden",
      "flex-shrink": "0",
    });
    const maxLines = typeof node.maxLines === "number" && node.maxLines >= 1 ? node.maxLines : 0;
    const clamp: Css = maxLines
      ? {
          display: "-webkit-box",
          "-webkit-box-orient": "vertical",
          "-webkit-line-clamp": String(maxLines),
          overflow: "hidden",
        }
      : { display: "block" };
    const inner = kit.child(scope, {
      inBox: false,
      style: { ...scope.style, parentAxis: undefined },
    });
    const item = (entry: WebElement | undefined): WebElement | undefined =>
      entry &&
      el(
        "span",
        {
          attrs: { "data-part": "item" },
          style: {
            display: "inline-block",
            "vertical-align": "top",
            "margin-inline-end": px(gap),
            "margin-bottom": px(rowGap),
          },
        },
        [entry],
      );
    const lines = el(
      "div",
      {
        attrs: { "data-part": "lines" },
        style: { ...clamp, "margin-inline-end": px(-gap), "margin-bottom": px(-rowGap) },
      },
      kit.children(node, inner, path, item),
    );
    return el("div", { attrs, style: css }, [lines]);
  };

/**
 * A lazy `list` draws every row its repeat yields (up to `maxItems`), with its header before and
 * footer after them, `spacing` apart inside `contentPadding`, in a column that scrolls vertically
 * or a row that scrolls horizontally, as Android's lazy list lays them out. A still draws it at its
 * opening scroll position.
 */
const listRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope, path) => {
    const horizontal = node.axis === "horizontal";
    const { attrs, style } = kit.base(node, scope, {
      display: "flex",
      "flex-direction": horizontal ? "row" : "column",
      // The style's alignment places rows on the cross axis, as the lazy list's alignment does.
      "align-items": lineCss(horizontal ? "row" : "column", node.style)["align-items"]!,
      gap: px(dp(node.spacing)),
      padding: px(dp(node.contentPadding)),
      [horizontal ? "overflow-x" : "overflow-y"]: "auto",
      "align-self": "stretch",
      ...(horizontal ? {} : { flex: "1 1 auto", "min-height": "0" }),
    });
    const inner = kit.child(scope, {
      inBox: false,
      style: { ...scope.style, parentAxis: horizontal ? "row" : "column" },
    });
    const cap = typeof node.maxItems === "number" ? node.maxItems : Number.POSITIVE_INFINITY;
    let rows = 0;
    const capped = (entry: WebElement | undefined): WebElement | undefined =>
      rows++ < cap ? entry : undefined;
    const slot = (name: "header" | "footer") => {
      const drawn = kit.renderNode(node[name], inner, `${path}.${name}`);
      return drawn ? [drawn] : [];
    };
    return el("div", { attrs: { ...attrs, role: "list" }, style }, [
      ...slot("header"),
      ...kit.children(node, inner, path, capped),
      ...slot("footer"),
    ]);
  };

/** Material's swipe-action container colours by role; a spec `color` overrides the container. */
const SWIPE_ROLES: Readonly<Record<string, [string, string]>> = {
  default: ["secondaryContainer", "onSecondaryContainer"],
  destructive: ["errorContainer", "onErrorContainer"],
};

function swipeAction(entry: unknown, scope: WebRenderScope, kit: WebRenderKit): WebElement[] {
  const action = record(entry);
  if (!action) {
    return [];
  }
  const roleName = action.role === "destructive" ? "destructive" : "default";
  const [background, foreground] = SWIPE_ROLES[roleName]!;
  const fill = cssColor(action.color ?? background, scope.style);
  const label = kit.bound(action.label, scope);
  const icon = action.icon === undefined ? [] : [sizedIcon(action.icon, 24, scope, kit)];
  return [
    el(
      "div",
      {
        attrs: { role: "button", "aria-label": label, "data-swipe-role": roleName },
        style: {
          display: "flex",
          "flex-direction": "column",
          "align-items": "center",
          "justify-content": "center",
          gap: "4px",
          "min-width": "72px",
          padding: "0 12px",
          ...textCss({ textStyle: "labelMedium" }, scope.style),
          ...(fill ? { "background-color": fill } : {}),
          color: role(foreground, scope),
        },
      },
      [...icon, label],
    ),
  ];
}

/**
 * A row or list item's `swipeActions`, as panels behind it. A still shows the item closed, as the
 * devices first draw it, so each edge's panel is present but hidden; the page runtime reveals it.
 */
export function withSwipeActions(
  element: WebElement,
  node: Raw,
  scope: WebRenderScope,
  kit: WebRenderKit,
): WebElement {
  const actions = record(node.swipeActions);
  if (!actions) {
    return element;
  }
  const panels = (["start", "end"] as const).flatMap((edge) => {
    const list = Array.isArray(actions[edge]) ? actions[edge] : [];
    const drawn = list.flatMap((entry) => swipeAction(entry, scope, kit));
    return drawn.length
      ? [el("div", { attrs: { "data-swipe-edge": edge, hidden: "" } }, drawn)]
      : [];
  });
  const attrs = {
    ...element.attrs,
    ...(actions.fullSwipe === true ? { "data-full-swipe": "true" } : {}),
  };
  return { ...element, attrs, children: [...element.children, ...panels] };
}

export function webIndicatorRenderers(kit: WebRenderKit): Record<string, NodeRenderer> {
  return {
    badge: badgeRenderer(kit),
    progress: progressRenderer(kit),
    fab: fabRenderer(kit),
    flow: flowRenderer(kit),
    list: listRenderer(kit),
  };
}
