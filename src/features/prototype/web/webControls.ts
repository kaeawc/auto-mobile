import { record, type Raw } from "../prototypeTemplate";
import { defaultFillAxes, filling, linkedPagerPage } from "./webCollections";
import { el, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import { cssColor, textCss } from "./webStyle";

type Css = Record<string, string>;

/** A spec state value at a state key, with repeat placeholders in the key bound first. */
function stateAt(key: unknown, scope: WebRenderScope, kit: WebRenderKit): unknown {
  return typeof key === "string" ? scope.condition.state[kit.bound(key, scope)] : undefined;
}

/** The icon placeholder at a size other than its default 24 px. */
function sizedIcon(name: string, size: number, scope: WebRenderScope, kit: WebRenderKit) {
  const glyph = kit.icon({ type: "icon", name }, scope, "");
  return { ...glyph, style: { ...glyph.style, width: `${size}px`, height: `${size}px` } };
}

/** Material 3 icon-button containers: [background role, icon role]; standard has no container. */
const ICON_BUTTON_ROLES: Readonly<Record<string, [string | undefined, string]>> = {
  standard: [undefined, "onSurfaceVariant"],
  filled: ["primary", "onPrimary"],
  tonal: ["secondaryContainer", "onSecondaryContainer"],
  outlined: [undefined, "onSurfaceVariant"],
};

/**
 * An icon button: the icon placeholder in a 40 px circle inside a 48 px touch target, with its
 * variant's Material 3 container. The icon name labels it when nothing else does.
 */
const iconButtonRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const variant = typeof node.variant === "string" ? node.variant : "standard";
    const [background, foreground] = ICON_BUTTON_ROLES[variant] ?? ICON_BUTTON_ROLES.standard!;
    const disabled = kit.disabledState(node, scope);
    const tint = cssColor(foreground, scope.style);
    const { attrs, style } = kit.base(node, scope, {
      display: "inline-flex",
      "align-items": "center",
      "justify-content": "center",
      width: "48px",
      height: "48px",
      "flex-shrink": "0",
      ...(tint ? { color: tint } : {}),
      ...disabled.css,
    });
    const fill = background ? cssColor(background, scope.style) : undefined;
    const outline = cssColor("outlineVariant", scope.style) ?? "currentColor";
    const container = el(
      "span",
      {
        attrs: { "data-part": "container" },
        style: {
          display: "inline-flex",
          "align-items": "center",
          "justify-content": "center",
          width: "40px",
          height: "40px",
          "border-radius": "50%",
          ...(fill ? { "background-color": fill } : {}),
          ...(variant === "outlined" ? { border: `1px solid ${outline}` } : {}),
        },
      },
      typeof node.icon === "string" ? [kit.icon({ type: "icon", name: node.icon }, scope, "")] : [],
    );
    const label = attrs["aria-label"] ?? String(node.icon ?? "");
    return el(
      "span",
      { attrs: { ...attrs, role: "button", "aria-label": label, ...disabled.attrs }, style },
      [container],
    );
  };

/**
 * A chip without a state key is an assist chip and one with a state key a filter chip, whatever
 * its `variant`, as both devices draw them: 32 px tall with an 8 px radius inside a 48 px target,
 * outlined, or tonal with a leading check while selected.
 */
function chipBody(
  chip: { selected: boolean; label: string; color?: string },
  scope: WebRenderScope,
  kit: WebRenderKit,
) {
  const { selected, label, color } = chip;
  const outline = cssColor("outlineVariant", scope.style) ?? "currentColor";
  const roles = selected
    ? kit.roleCss(scope, "secondaryContainer", "onSecondaryContainer")
    : kit.roleCss(scope, "transparent", "onSurface");
  return el(
    "span",
    {
      attrs: { "data-part": "chip" },
      style: {
        display: "inline-flex",
        "align-items": "center",
        gap: "8px",
        height: "32px",
        "padding-inline": selected ? "8px 16px" : "16px",
        "border-radius": "8px",
        ...textCss({ textStyle: "labelLarge" }, scope.style),
        border: selected ? "1px solid transparent" : `1px solid ${outline}`,
        ...roles,
        // An authored foreground wins over the Material role, as on the devices.
        ...(color ? { color } : {}),
      },
    },
    [...(selected ? [sizedIcon("check", 18, scope, kit)] : []), label],
  );
}

const chipRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const filter = typeof node.stateKey === "string";
    const selected = filter && stateAt(node.stateKey, scope, kit) === true;
    const disabled = kit.disabledState(node, scope);
    const { attrs, style } = kit.base(node, scope, {
      display: "inline-flex",
      "align-items": "center",
      "min-height": "48px",
      "flex-shrink": "0",
      ...disabled.css,
    });
    const role: Css = filter
      ? { role: "checkbox", "aria-checked": String(selected) }
      : { role: "button" };
    return el("div", { attrs: { ...attrs, ...role, ...disabled.attrs }, style }, [
      chipBody({ selected, label: kit.bound(node.label, scope), color: style.color }, scope, kit),
    ]);
  };

/** The slider's shown value: its state number, else 0, snapped to `step` and clamped to the range. */
function sliderValue(node: Raw, scope: WebRenderScope, kit: WebRenderKit): number {
  const min = typeof node.min === "number" ? node.min : 0;
  const max = typeof node.max === "number" ? Math.max(node.max, min) : min;
  const raw = stateAt(node.stateKey, scope, kit);
  const value = Math.min(Math.max(typeof raw === "number" ? raw : 0, min), max);
  const step = typeof node.step === "number" && node.step > 0 ? node.step : undefined;
  if (step === undefined) {
    return value;
  }
  const snapped = min + Math.round((value - min) / step) * step;
  return Math.min(Math.max(Math.round(snapped * 1e6) / 1e6, min), max);
}

const percent = (fraction: number) => `${Number((fraction * 100).toFixed(3))}%`;

/** A segment of the 16 px track: the active part before the thumb or the inactive part after it. */
function trackPart(
  part: "active" | "inactive",
  length: string,
  color: string | undefined,
): WebElement {
  return el("span", {
    attrs: { "data-part": part },
    style: {
      position: "absolute",
      top: "14px",
      height: "16px",
      width: `max(0px, calc(${length} - 6px))`,
      "border-radius": "8px",
      [part === "active" ? "inset-inline-start" : "inset-inline-end"]: "0",
      ...(color ? { "background-color": color } : {}),
    },
  });
}

/**
 * A Material 3 slider: a 16 px track, primary up to the value and secondaryContainer after it with
 * a stop dot at its end, and a 4x44 px primary thumb at the value, 6 px clear of each part.
 */
function sliderTrack(fraction: number, scope: WebRenderScope): WebElement {
  const primary = cssColor("primary", scope.style);
  const inactive = cssColor("secondaryContainer", scope.style);
  const fill: Css = primary ? { "background-color": primary } : {};
  return el("span", { style: { position: "relative", display: "block", height: "44px" } }, [
    trackPart("active", percent(fraction), primary),
    trackPart("inactive", percent(1 - fraction), inactive),
    el("span", {
      attrs: { "data-part": "stop" },
      style: {
        position: "absolute",
        top: "20px",
        "inset-inline-end": "6px",
        width: "4px",
        height: "4px",
        "border-radius": "50%",
        ...fill,
      },
    }),
    el("span", {
      attrs: { "data-part": "thumb" },
      style: {
        position: "absolute",
        top: "0",
        "inset-inline-start": `calc(${percent(fraction)} - 2px)`,
        width: "4px",
        height: "44px",
        "border-radius": "2px",
        ...fill,
      },
    }),
  ]);
}

const sliderRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (raw, scope) => {
    // As on Android, the slider fills its width with its label above the track.
    const node = filling(raw, defaultFillAxes(raw));
    const min = typeof node.min === "number" ? node.min : 0;
    const max = typeof node.max === "number" ? node.max : min;
    const value = sliderValue(node, scope, kit);
    const fraction = max > min ? (value - min) / (max - min) : 0;
    const disabled = kit.disabledState(node, scope);
    const { attrs, style } = kit.base(node, scope, {
      display: "flex",
      "flex-direction": "column",
      ...disabled.css,
    });
    const semantics = {
      role: "slider",
      "aria-valuenow": String(value),
      "aria-valuemin": String(min),
      "aria-valuemax": String(max),
    };
    const label =
      typeof node.label === "string"
        ? // A plain label takes Material 3's default text style, as PrototypeComponentLabel does.
          [
            el("span", { style: textCss({ textStyle: "bodyLarge" }, scope.style) }, [
              kit.bound(node.label, scope),
            ]),
          ]
        : [];
    return el("div", { attrs: { ...attrs, ...semantics, ...disabled.attrs }, style }, [
      ...label,
      sliderTrack(fraction, scope),
    ]);
  };

interface NavItem {
  readonly label: string;
  readonly icon?: string;
  readonly image: boolean;
}

function navItems(node: Raw, scope: WebRenderScope, kit: WebRenderKit): NavItem[] {
  const items = Array.isArray(node.items) ? node.items : [];
  return items.map((entry) => {
    const item = record(entry) ?? {};
    return {
      label: kit.bound(item.label, scope),
      ...(typeof item.icon === "string" ? { icon: item.icon } : {}),
      image: item.image !== undefined,
    };
  });
}

/**
 * The selected item, as both devices pick it: the linked pager's page, else the state key's
 * number, else the first, clamped to the items.
 */
function navSelection(node: Raw, count: number, scope: WebRenderScope, kit: WebRenderKit): number {
  const linked =
    typeof node.pager === "string" ? linkedPagerPage(node.pager, scope, kit) : undefined;
  const value = stateAt(node.stateKey, scope, kit);
  const chosen =
    linked ?? (typeof value === "number" && Number.isFinite(value) ? Math.trunc(value) : 0);
  return Math.min(Math.max(chosen, 0), Math.max(count - 1, 0));
}

/**
 * An item's icon: its named icon, else (an image is not inlined, or none is given) Android's 24 px
 * surfaceVariant placeholder square.
 */
function navIcon(item: NavItem, scope: WebRenderScope, kit: WebRenderKit): WebElement {
  if (item.icon !== undefined) {
    return kit.icon({ type: "icon", name: item.icon }, scope, "");
  }
  const fill = cssColor("surfaceVariant", scope.style);
  return el("span", {
    attrs: { "data-part": "placeholder" },
    style: {
      display: "block",
      width: "24px",
      height: "24px",
      "flex-shrink": "0",
      ...(fill ? { "background-color": fill } : {}),
    },
  });
}

/** The bar's own edges, which an explicit width or height in the spec still overrides. */
function barBase(node: Raw, scope: WebRenderScope, kit: WebRenderKit, extra: Css) {
  return kit.base(filling(node, defaultFillAxes(node)), scope, { display: "flex", ...extra });
}

function bottomNavItem(item: NavItem, selected: boolean, scope: WebRenderScope, kit: WebRenderKit) {
  const indicator = selected ? cssColor("secondaryContainer", scope.style) : undefined;
  const iconColor = cssColor(selected ? "onSecondaryContainer" : "onSurfaceVariant", scope.style);
  const labelColor = cssColor(selected ? "onSurface" : "onSurfaceVariant", scope.style);
  const pill = el(
    "span",
    {
      attrs: { "data-part": "indicator" },
      style: {
        display: "flex",
        "align-items": "center",
        "justify-content": "center",
        width: "64px",
        height: "32px",
        "border-radius": "16px",
        ...(indicator ? { "background-color": indicator } : {}),
        ...(iconColor ? { color: iconColor } : {}),
      },
    },
    [navIcon(item, scope, kit)],
  );
  const label = el(
    "span",
    {
      style: {
        ...textCss({ textStyle: "labelMedium" }, scope.style),
        ...(labelColor ? { color: labelColor } : {}),
      },
    },
    [item.label],
  );
  return el(
    "div",
    {
      attrs: { role: "tab", "aria-selected": String(selected) },
      style: {
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        gap: "4px",
        flex: "1 1 0",
        "min-width": "0",
        "padding-top": "12px",
        "padding-bottom": "16px",
      },
    },
    [pill, label],
  );
}

/**
 * Android's NavigationBar pads its bottom edge by the system bar, as iOS does, on top of the
 * spec's own safeAreaPadding, unless an ancestor or that padding already took the bottom edge.
 */
function withBottomInset(node: Raw, scope: WebRenderScope, kit: WebRenderKit, style: Css): Css {
  const taken =
    (scope.consumedInsets ?? []).includes("bottom") || kit.safeAreaEdges(node).includes("bottom");
  if (taken) {
    return style;
  }
  return {
    ...style,
    "padding-bottom": `calc(${style["padding-bottom"] ?? "0px"} + var(--safe-bottom))`,
  };
}

/** A Material 3 navigation bar: 80 px on surfaceContainer, each item an icon in a pill over a label. */
const bottomNavRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const items = navItems(node, scope, kit);
    const selected = navSelection(node, items.length, scope, kit);
    const { attrs, style: barStyle } = barBase(node, scope, kit, {
      "min-height": "80px",
      gap: "8px",
      "padding-inline": "8px",
      ...kit.roleCss(scope, "surfaceContainer", "onSurface"),
    });
    const style = withBottomInset(node, scope, kit, barStyle);
    return el(
      "div",
      { attrs: { ...attrs, role: "tablist" }, style },
      items.map((item, index) => bottomNavItem(item, index === selected, scope, kit)),
    );
  };

interface TabLayout {
  readonly scrollable: boolean;
  readonly icons: boolean;
  readonly scope: WebRenderScope;
  readonly kit: WebRenderKit;
}

function tab(item: NavItem, selected: boolean, layout: TabLayout) {
  const { scope, kit } = layout;
  const primary = cssColor("primary", scope.style) ?? "currentColor";
  const color = selected ? primary : cssColor("onSurfaceVariant", scope.style);
  const visual = item.icon !== undefined || item.image ? [navIcon(item, scope, kit)] : [];
  return el(
    "div",
    {
      attrs: { role: "tab", "aria-selected": String(selected) },
      style: {
        display: "flex",
        "flex-direction": "column",
        "align-items": "center",
        "justify-content": "center",
        gap: "2px",
        "min-height": layout.icons ? "72px" : "48px",
        "padding-inline": "16px",
        ...textCss({ textStyle: "titleSmall" }, scope.style),
        ...(layout.scrollable
          ? { flex: "0 0 auto", "min-width": "90px" }
          : { flex: "1 1 0", "min-width": "0" }),
        ...(color ? { color } : {}),
        ...(selected ? { "box-shadow": `inset 0 -3px 0 0 ${primary}` } : {}),
      },
    },
    [...visual, item.label],
  );
}

/**
 * A Material 3 tab row on surface with a bottom divider: 48 px, or 72 px when a tab has an icon. The
 * selected tab takes the primary colour and a 3 px primary indicator; a scrollable row starts after
 * a 52 px edge padding and clips the tabs beyond the screen.
 */
const tabBarRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const items = navItems(node, scope, kit);
    const selected = navSelection(node, items.length, scope, kit);
    const layout: TabLayout = {
      scrollable: node.scrollable === true,
      icons: items.some((item) => item.icon !== undefined || item.image),
      scope,
      kit,
    };
    const divider = cssColor("outlineVariant", scope.style) ?? "currentColor";
    const { attrs, style } = barBase(node, scope, kit, {
      "min-height": layout.icons ? "72px" : "48px",
      "border-bottom": `1px solid ${divider}`,
      ...(layout.scrollable ? { "padding-inline-start": "52px", overflow: "hidden" } : {}),
      ...kit.roleCss(scope, "surface", "onSurface"),
    });
    return el(
      "div",
      { attrs: { ...attrs, role: "tablist" }, style },
      items.map((item, index) => tab(item, index === selected, layout)),
    );
  };

export function webControlRenderers(kit: WebRenderKit): Record<string, NodeRenderer> {
  return {
    iconButton: iconButtonRenderer(kit),
    chip: chipRenderer(kit),
    slider: sliderRenderer(kit),
    bottomNav: bottomNavRenderer(kit),
    tabBar: tabBarRenderer(kit),
  };
}
