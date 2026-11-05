import { record, type Raw } from "../prototypeTemplate";
import { el, type WebChild, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import { cssColor, fontPx } from "./webStyle";

type Css = Record<string, string>;

/**
 * The SwiftUI text styles the iOS renderer uses, at the default Dynamic Type size: size and line
 * height in points, which the still draws as px.
 */
const IOS_TEXT_STYLES = {
  largeTitle: [34, 41],
  title: [28, 34],
  title3: [20, 25],
  body: [17, 22],
  subheadline: [15, 20],
  footnote: [13, 18],
} as const satisfies Record<string, readonly [number, number]>;

export type IosTextStyle = keyof typeof IOS_TEXT_STYLES;

/** A SwiftUI text style as CSS, scaled by the frame's Dynamic Type size, at a weight (regular unless given). */
export function iosText(textStyle: IosTextStyle, scope: WebRenderScope, weight = 400): Css {
  const [size, line] = IOS_TEXT_STYLES[textStyle];
  return {
    "font-size": fontPx(size, scope.style),
    "line-height": fontPx(line, scope.style),
    "font-weight": String(weight),
  };
}

/** A theme role as CSS, else the system colour the iOS renderer falls back to. */
function role(name: string, fallback: string, scope: WebRenderScope): string {
  return cssColor(name, scope.style) ?? fallback;
}

/** Whether a state key, with repeat placeholders bound first, holds `true`. */
function stateOn(stateKey: unknown, scope: WebRenderScope, kit: WebRenderKit): boolean {
  const key = typeof stateKey === "string" ? kit.bound(stateKey, scope) : undefined;
  return key !== undefined && scope.condition.state[key] === true;
}

function glyph(name: string, scope: WebRenderScope, kit: WebRenderKit): WebElement {
  return kit.icon({ type: "icon", name }, scope, "");
}

/**
 * The iOS renderer's switch track, drawn in SwiftUI rather than as a UISwitch: a 51x31 capsule,
 * `primary` when on (systemGreen untinted) and `surfaceContainerHighest` when off (systemFill),
 * holding a 27 px `onPrimary` thumb inset 2 px at the end it is on.
 */
export function iosSwitchTrack(on: boolean, scope: WebRenderScope): WebElement {
  const thumb = el("span", {
    attrs: { "data-part": "thumb" },
    style: {
      width: "27px",
      height: "27px",
      "border-radius": "50%",
      "background-color": role("onPrimary", "#ffffff", scope),
      "box-shadow": "0 1px 1px rgba(0,0,0,0.2)",
    },
  });
  const fill = on
    ? role("primary", "rgba(52,199,89,1)", scope)
    : role("surfaceContainerHighest", "rgba(120,120,128,0.16)", scope);
  return el(
    "span",
    {
      attrs: { "data-part": "track" },
      style: {
        display: "flex",
        "align-items": "center",
        "justify-content": on ? "flex-end" : "flex-start",
        width: "51px",
        height: "31px",
        padding: "2px",
        "border-radius": "15.5px",
        "flex-shrink": "0",
        "background-color": fill,
      },
    },
    [thumb],
  );
}

/**
 * The SF Symbol `checkmark.square.fill` or `square` the iOS renderer draws for a checkbox, in the
 * content colour: a filled or outlined 17 px rounded square (glyphs follow #16526).
 */
export function iosCheckSquare(on: boolean): WebElement {
  return el("span", {
    attrs: { "data-part": "box" },
    style: {
      width: "17px",
      height: "17px",
      "border-radius": "4px",
      "flex-shrink": "0",
      border: "1.5px solid currentColor",
      ...(on ? { "background-color": "currentColor" } : {}),
    },
  });
}

/**
 * A switch or checkbox as the iOS renderer draws one: a plain button at least 44 pt tall in the
 * body style. A switch's label fills the row before its track; iOS has no checkbox control, so a
 * checkbox is its check square 8 pt before its label.
 */
export const iosToggleRenderer =
  (kind: "switch" | "checkbox", kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const on = stateOn(node.stateKey, scope, kit);
    const disabled = kit.disabledState(node, scope);
    const { attrs, style } = kit.base(node, scope, {
      display: "flex",
      "align-items": "center",
      gap: "8px",
      "min-height": "44px",
      ...iosText("body", scope),
      ...disabled.css,
    });
    const semantics = { ...attrs, role: kind, "aria-checked": String(on), ...disabled.attrs };
    const label = typeof node.label === "string" ? kit.bound(node.label, scope) : undefined;
    if (kind === "checkbox") {
      return el("div", { attrs: semantics, style }, [
        iosCheckSquare(on),
        ...(label ? [label] : []),
      ]);
    }
    const leading = label ? [el("span", { style: { flex: "1 1 auto" } }, [label])] : [];
    return el("div", { attrs: semantics, style }, [...leading, iosSwitchTrack(on, scope)]);
  };

/** A list row's trailing switch track, check square or `onSurfaceVariant` icon. */
function listTrailing(node: Raw, scope: WebRenderScope, kit: WebRenderKit): WebChild[] {
  const entry = record(node.trailing);
  if (entry?.type === "switch" || entry?.type === "checkbox") {
    const on = stateOn(entry.stateKey, scope, kit);
    const mark = entry.type === "switch" ? iosSwitchTrack(on, scope) : iosCheckSquare(on);
    return [
      el(
        "span",
        { attrs: { role: entry.type, "aria-checked": String(on) }, style: { display: "flex" } },
        [mark],
      ),
    ];
  }
  if (entry?.type === "icon" && typeof entry.name === "string") {
    return [el("span", { style: variantColor(scope) }, [glyph(entry.name, scope, kit)])];
  }
  return [];
}

function variantColor(scope: WebRenderScope): Css {
  const color = cssColor("onSurfaceVariant", scope.style);
  return color ? { color } : {};
}

/**
 * A list row as the iOS renderer draws one: 16 pt apart, a body headline over a subheadline
 * supporting line (2 pt apart, `onSurfaceVariant`), padded 16x8 pt to at least 56 pt, or 72 pt
 * with a supporting line. An authored colour tints the leading icon and supporting text too.
 */
export const iosListItemRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const disabled = kit.disabledState(node, scope);
    const { attrs, style } = kit.base(node, scope, {
      display: "flex",
      "align-items": "center",
      gap: "16px",
      "min-height": node.supporting === undefined ? "56px" : "72px",
      padding: "8px 16px",
      "align-self": "stretch",
      ...disabled.css,
    });
    const secondary = cssColor(record(node.style)?.color, scope.style) ? {} : variantColor(scope);
    const leading =
      typeof node.leadingIcon === "string"
        ? [
            el("span", { style: { display: "flex", ...secondary } }, [
              glyph(node.leadingIcon, scope, kit),
            ]),
          ]
        : [];
    const supporting =
      node.supporting === undefined
        ? []
        : [
            el("span", { style: { ...iosText("subheadline", scope), ...secondary } }, [
              kit.bound(node.supporting, scope),
            ]),
          ];
    const texts = el(
      "div",
      { style: { display: "flex", "flex-direction": "column", gap: "2px", flex: "1 1 auto" } },
      [
        el("span", { style: iosText("body", scope) }, [kit.bound(node.headline, scope)]),
        ...supporting,
      ],
    );
    return el("div", { attrs: { ...attrs, role: "listitem", ...disabled.attrs }, style }, [
      ...leading,
      texts,
      ...listTrailing(node, scope, kit),
    ]);
  };

/**
 * A chip as the iOS renderer draws one, assist or filter alike: a 32 pt row padded 12 pt with an
 * 8 pt radius, in the medium subheadline style and the content colour, inside a 44 pt target.
 * Selected, it is `secondaryContainer` behind a leading check; otherwise an `outlineVariant` outline.
 */
export const iosChipRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const filter = typeof node.stateKey === "string";
    const selected = filter && stateOn(node.stateKey, scope, kit);
    const disabled = kit.disabledState(node, scope);
    const { attrs, style } = kit.base(node, scope, {
      display: "inline-flex",
      "align-items": "center",
      "min-height": "44px",
      "flex-shrink": "0",
      color: role("onSurface", "currentColor", scope),
      ...disabled.css,
    });
    const body = el(
      "span",
      {
        attrs: { "data-part": "chip" },
        style: {
          display: "inline-flex",
          "align-items": "center",
          gap: "8px",
          height: "32px",
          "padding-inline": "12px",
          "border-radius": "8px",
          ...iosText("subheadline", scope, 500),
          border: `1px solid ${selected ? "transparent" : role("outlineVariant", "rgba(60,60,67,0.29)", scope)}`,
          ...(selected
            ? { "background-color": role("secondaryContainer", "transparent", scope) }
            : {}),
        },
      },
      [...(selected ? [glyph("check", scope, kit)] : []), kit.bound(node.label, scope)],
    );
    const semantics: Css = filter
      ? { role: "checkbox", "aria-checked": String(selected) }
      : { role: "button" };
    return el("div", { attrs: { ...attrs, ...semantics, ...disabled.attrs }, style }, [body]);
  };

/** An app-bar action as the iOS renderer draws one: its glyph centred in a 48 pt button. */
function barButtons(
  slots: readonly unknown[],
  scope: WebRenderScope,
  kit: WebRenderKit,
): WebElement[] {
  return slots.flatMap((slot) => {
    const action = record(slot);
    if (typeof action?.icon !== "string") {
      return [];
    }
    const label = typeof action.label === "string" ? kit.bound(action.label, scope) : action.icon;
    return [
      el(
        "span",
        {
          attrs: { role: "button", "aria-label": label },
          style: {
            display: "inline-flex",
            "align-items": "center",
            "justify-content": "center",
            width: "48px",
            height: "48px",
            "flex-shrink": "0",
          },
        },
        [glyph(action.icon, scope, kit)],
      ),
    ];
  });
}

const ONE_LINE: Css = { "white-space": "nowrap", overflow: "hidden", "text-overflow": "ellipsis" };

/** The title in the icon row: small bars lead with it, center-aligned bars centre it on the row. */
function rowTitle(node: Raw, scope: WebRenderScope, text: string): WebElement[] {
  const variant = typeof node.variant === "string" ? node.variant : "small";
  const style = { ...iosText("title3", scope, 600), ...ONE_LINE };
  if (variant === "small") {
    const lead = node.navigationIcon === undefined ? "12px" : "4px";
    return [
      el("span", { style: { ...style, flex: "1 1 auto", "padding-inline-start": lead } }, [text]),
    ];
  }
  if (variant === "centerAligned") {
    const centred: Css = {
      position: "absolute",
      left: "0",
      right: "0",
      "padding-inline": "56px",
      "text-align": "center",
      "pointer-events": "none",
    };
    return [el("span", { style: { ...style, ...centred } }, [text])];
  }
  return [];
}

/** The scroll behaviours for which the iOS renderer frames the expanded title at a fixed height. */
const FRAMED_ON_SCROLL: ReadonlySet<unknown> = new Set(["enterAlways", "exitUntilCollapsed"]);

/**
 * A medium or large bar's title on its own line below the icons: `.title` or `.largeTitle`, padded
 * 16 pt across and 20 or 28 pt below. With an `enterAlways` or `exitUntilCollapsed` scroll
 * behaviour the iOS renderer frames that padded line at 48 or 88 pt, bottom-aligned.
 */
function expandedTitle(node: Raw, scope: WebRenderScope, text: string): WebElement[] {
  const variant = typeof node.variant === "string" ? node.variant : "small";
  if (variant !== "medium" && variant !== "large") {
    return [];
  }
  const large = variant === "large";
  const title = el(
    "span",
    {
      style: {
        ...iosText(large ? "largeTitle" : "title", scope),
        ...ONE_LINE,
        padding: `0 16px ${large ? 28 : 20}px`,
      },
    },
    [text],
  );
  if (!FRAMED_ON_SCROLL.has(node.onScroll)) {
    return [title];
  }
  const frame: Css = {
    display: "flex",
    "flex-direction": "column",
    "justify-content": "flex-end",
    height: large ? "88px" : "48px",
  };
  return [el("div", { attrs: { "data-part": "expanded-title" }, style: frame }, [title])];
}

/**
 * A top app bar as the iOS renderer draws one: a 64 pt row padded 4 pt with 48 pt icon buttons. A
 * small bar leads with its title (`.title3` semibold, 12 pt in, or 4 pt after a navigation icon),
 * a center-aligned bar centres it, and medium and large bars put a `.title` or `.largeTitle` line
 * below the row. Like the iOS renderer, it is a drawn bar: `ios.navigationTitle` changes nothing.
 */
export const iosTopAppBarRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const variant = typeof node.variant === "string" ? node.variant : "small";
    const { attrs, style } = kit.base(node, scope, {
      display: "flex",
      "flex-direction": "column",
      "align-self": "stretch",
      ...kit.roleCss(scope, "surface", "onSurface"),
    });
    const text = kit.bound(node.title, scope);
    const actions = Array.isArray(node.actions) ? node.actions : [];
    const row = el(
      "div",
      {
        style: {
          display: "flex",
          "align-items": "center",
          "min-height": "64px",
          "padding-inline": "4px",
          position: "relative",
        },
      },
      [
        ...barButtons([node.navigationIcon], scope, kit),
        ...rowTitle(node, scope, text),
        // Outside a small bar the title leaves the row, so a spacer keeps the actions at the end.
        ...(variant === "small" ? [] : [el("span", { style: { flex: "1 1 auto" } })]),
        ...barButtons(actions, scope, kit),
      ],
    );
    return el("div", { attrs: { ...attrs, role: "heading" }, style }, [
      row,
      ...expandedTitle(node, scope, text),
    ]);
  };

/**
 * A card's container as the iOS renderer draws it: `surfaceContainerHigh` when filled (the
 * default), else `surface`; an `outlineVariant` outline when outlined; a 1 pt shadow when elevated.
 */
export function iosCardChrome(variant: unknown, scope: WebRenderScope): Css {
  const filled = variant === undefined || variant === "filled";
  const fill = filled
    ? role("surfaceContainerHigh", "rgba(242,242,247,1)", scope)
    : role("surface", "rgba(255,255,255,1)", scope);
  const content = cssColor("onSurface", scope.style);
  return {
    "background-color": fill,
    ...(content ? { color: content } : {}),
    ...(variant === "outlined"
      ? { border: `1px solid ${role("outlineVariant", "rgba(60,60,67,0.29)", scope)}` }
      : {}),
    ...(variant === "elevated" ? { "box-shadow": "0 1px 2px rgba(0,0,0,0.2)" } : {}),
  };
}
