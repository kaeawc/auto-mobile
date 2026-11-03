import { record, type Raw } from "../prototypeTemplate";
import { defaultFillAxes, filling } from "./webCollections";
import { el, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import {
  iosChipRenderer,
  iosListItemRenderer,
  iosText,
  iosToggleRenderer,
  iosTopAppBarRenderer,
} from "./webSkinIos";
import { cssColor, rgbaCss } from "./webStyle";

/**
 * A platform skin: how the still draws the components whose look differs between the devices.
 * The frame's platform picks it, and a caller may name one explicitly. Components a skin leaves
 * out draw with the shared (Material 3) renderers, as both devices draw them.
 */
export type WebSkinId = "android" | "ios";

export interface WebSkin {
  readonly id: WebSkinId;
  /** Renderers that replace the shared ones for this skin. */
  readonly renderers: Readonly<Record<string, NodeRenderer>>;
}

type Css = Record<string, string>;

/**
 * The node's platform namespace for the scope's skin (`ios` in the iOS skin, `android` in the
 * Android one); another platform's namespace is never read.
 */
export function skinNamespace(node: Raw, scope: WebRenderScope): Raw | undefined {
  return record(node[scope.skin ?? "android"]);
}

/** SwiftUI's body text style: 17 pt on a 22 pt line. */
const IOS_BODY: Css = iosText("body");

/** UIKit's systemBlue, the accent a SwiftUI Slider takes when nothing tints it. */
function systemBlue(scope: WebRenderScope): string {
  return scope.style.mode === "dark" ? "rgba(10,132,255,1)" : "rgba(0,122,255,1)";
}

/** UIKit's systemFill, the unfilled part of a slider track. */
function systemFill(scope: WebRenderScope): string {
  return scope.style.mode === "dark" ? "rgba(120,120,128,0.36)" : "rgba(120,120,128,0.2)";
}

/** The theme's `primary` at an opacity, else a translucent current colour. */
function primaryAt(scope: WebRenderScope, alpha: number): string {
  const primary = scope.style.palette.get("primary");
  return primary ? rgbaCss({ ...primary, a: primary.a * alpha }) : "transparent";
}

/** The chrome of each SwiftUI button style the iOS renderer applies, at its regular control size. */
function iosButtonChrome(variant: string, glass: string | undefined, scope: WebRenderScope): Css {
  const tint = cssColor("primary", scope.style) ?? systemBlue(scope);
  const padded: Css = { padding: "7px 12px", "min-height": "34px", "border-radius": "6px" };
  if (glass === "glassProminent") {
    return { ...padded, "border-radius": "9999px", "background-color": tint, color: "#ffffff" };
  }
  if (glass === "glass") {
    return {
      ...padded,
      "border-radius": "9999px",
      "background-color": primaryAt(scope, 0.15),
      color: tint,
    };
  }
  switch (variant) {
    case "outlined":
      // The iOS renderer's own outline: a 1 pt tint capsule around 16x8 pt padding, no fill.
      return {
        padding: "8px 16px",
        "border-radius": "9999px",
        border: `1px solid ${tint}`,
        color: tint,
      };
    case "tonal":
      return { ...padded, "background-color": primaryAt(scope, 0.15), color: tint };
    case "elevated":
      return {
        ...padded,
        "background-color": primaryAt(scope, 0.15),
        color: tint,
        "box-shadow": "0 1px 2px rgba(0,0,0,0.2)",
      };
    case "text":
      return { color: tint };
    default:
      // `.borderedProminent`: a tint fill under white text.
      return { ...padded, "background-color": tint, color: "#ffffff" };
  }
}

/**
 * A native SwiftUI button, as the iOS renderer draws one: `.borderedProminent` (filled),
 * `.bordered` (tonal, and elevated with a shadow), `.borderless` (text) or a tint capsule
 * (outlined), tinted with the theme's primary, in the body text style. `ios.buttonStyle` draws
 * the glass styles as capsules (the still draws no blur). A leading icon sits 6 pt before the label.
 */
const iosButtonRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const disabled = kit.disabledState(node, scope);
    const variant = typeof node.variant === "string" ? node.variant : "filled";
    const glass = skinNamespace(node, scope)?.buttonStyle;
    const { attrs, style } = kit.base(node, scope, {
      display: "inline-flex",
      "align-items": "center",
      "justify-content": "center",
      "box-sizing": "border-box",
      "text-align": "center",
      gap: "6px",
      ...IOS_BODY,
      ...iosButtonChrome(variant, typeof glass === "string" ? glass : undefined, scope),
      ...disabled.css,
    });
    const icon =
      typeof node.icon === "string" ? [kit.icon({ type: "icon", name: node.icon }, scope, "")] : [];
    return el("div", { attrs: { ...attrs, role: "button", ...disabled.attrs }, style }, [
      ...icon,
      kit.bound(node.label, scope),
    ]);
  };

/**
 * The value a SwiftUI Slider shows: its state number, else `min`, clamped to `min`..`max`, where
 * `max` defaults to 1 and always exceeds `min`, as the iOS renderer binds it. Snapping happens on
 * drag, so the shown value is not snapped.
 */
function iosSliderValue(node: Raw, scope: WebRenderScope, kit: WebRenderKit) {
  const min = typeof node.min === "number" ? node.min : 0;
  const max = Math.max(typeof node.max === "number" ? node.max : 1, min + 0.000001);
  const key = typeof node.stateKey === "string" ? kit.bound(node.stateKey, scope) : undefined;
  const raw = key === undefined ? undefined : scope.condition.state[key];
  const value = Math.min(Math.max(typeof raw === "number" ? raw : min, min), max);
  return { min, max, value, fraction: (value - min) / (max - min) };
}

/** The 28 pt slider: a 4 pt track, tinted up to the value, under a white 28 pt thumb. */
function iosSliderTrack(fraction: number, scope: WebRenderScope): WebElement {
  // The thumb's centre travels between 14 pt from each end.
  const at = `calc(14px + (100% - 28px) * ${Number(fraction.toFixed(6))})`;
  const track: Css = { position: "absolute", top: "12px", height: "4px", "border-radius": "2px" };
  return el("span", { style: { position: "relative", display: "block", height: "28px" } }, [
    el("span", {
      attrs: { "data-part": "inactive" },
      style: { ...track, "inset-inline": "0", "background-color": systemFill(scope) },
    }),
    el("span", {
      attrs: { "data-part": "active" },
      style: {
        ...track,
        "inset-inline-start": "0",
        width: at,
        "background-color": systemBlue(scope),
      },
    }),
    el("span", {
      attrs: { "data-part": "thumb" },
      style: {
        position: "absolute",
        top: "0",
        "inset-inline-start": `calc(${at} - 14px)`,
        width: "28px",
        height: "28px",
        "border-radius": "50%",
        "background-color": "#ffffff",
        "box-shadow": "0 0.5px 4px rgba(0,0,0,0.12),0 6px 13px rgba(0,0,0,0.12)",
      },
    }),
  ]);
}

/**
 * A native SwiftUI Slider, as the iOS renderer draws one: its label above (4 pt apart) in the body
 * style and the content colour, then the system slider, which fills its width.
 */
const iosSliderRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (raw, scope) => {
    const node = filling(raw, defaultFillAxes(raw));
    const { min, max, value, fraction } = iosSliderValue(node, scope, kit);
    const disabled = kit.disabledState(node, scope);
    const { attrs, style } = kit.base(node, scope, {
      display: "flex",
      "flex-direction": "column",
      gap: "4px",
      ...disabled.css,
    });
    const semantics = {
      role: "slider",
      "aria-valuenow": String(value),
      "aria-valuemin": String(min),
      "aria-valuemax": String(max),
    };
    const color =
      cssColor(record(node.style)?.color, scope.style) ?? cssColor("onSurface", scope.style);
    const label =
      typeof node.label === "string"
        ? [
            el("span", { style: { ...IOS_BODY, ...(color ? { color } : {}) } }, [
              kit.bound(node.label, scope),
            ]),
          ]
        : [];
    return el("div", { attrs: { ...attrs, ...semantics, ...disabled.attrs }, style }, [
      ...label,
      iosSliderTrack(fraction, scope),
    ]);
  };

export function webSkins(kit: WebRenderKit): Readonly<Record<WebSkinId, WebSkin>> {
  return {
    android: { id: "android", renderers: {} },
    ios: {
      id: "ios",
      renderers: {
        button: iosButtonRenderer(kit),
        slider: iosSliderRenderer(kit),
        switch: iosToggleRenderer("switch", kit),
        checkbox: iosToggleRenderer("checkbox", kit),
        listItem: iosListItemRenderer(kit),
        chip: iosChipRenderer(kit),
        topAppBar: iosTopAppBarRenderer(kit),
      },
    },
  };
}
