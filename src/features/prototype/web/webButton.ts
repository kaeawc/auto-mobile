import { el } from "./webNodes";
import type { NodeRenderer, WebRenderKit } from "./webRender";
import { record } from "../prototypeTemplate";
import { cssColor, textCss } from "./webStyle";

/** Material 3 button containers: [background role, label role]; outlined and text have none. */
const BUTTON_ROLES: Readonly<Record<string, [string, string]>> = {
  filled: ["primary", "onPrimary"],
  tonal: ["secondaryContainer", "onSecondaryContainer"],
  elevated: ["surfaceContainerLow", "primary"],
};

/**
 * The padding either side of a button's content, the same for every variant as Android passes it:
 * ButtonDefaults.ContentPadding's 24 px, or ButtonWithIconContentPadding's 16 px before an icon.
 */
const buttonPadding = (icon: boolean): string => (icon ? "0 24px 0 16px" : "0 24px");

/**
 * A Material 3 button, as Compose draws it: a 40 px pill at least 58 px wide in its variant's
 * container, 4 px above and below to reach the 48 px touch target a clickable Surface keeps
 * (minimumInteractiveComponentSize), an optional 18 px leading icon 8 px before a `labelLarge`
 * label (#16611). An authored height replaces the pill's and drops the touch-target margin.
 */
export const materialButtonRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const disabled = kit.disabledState(node, scope);
    const variant = typeof node.variant === "string" ? node.variant : "filled";
    const roles = BUTTON_ROLES[variant];
    const hasIcon = typeof node.icon === "string";
    const outline: Record<string, string> =
      variant === "outlined"
        ? { border: `1px solid ${cssColor("outline", scope.style) ?? "currentColor"}` }
        : {};
    const authoredHeight = record(node.style)?.height !== undefined;
    const { attrs, style } = kit.base(node, scope, {
      display: "inline-flex",
      "align-items": "center",
      "justify-content": "center",
      "box-sizing": "border-box",
      "min-height": "40px",
      "min-width": "58px",
      ...(authoredHeight ? {} : { "margin-block": "4px" }),
      padding: buttonPadding(hasIcon),
      "border-radius": "20px",
      ...(roles
        ? kit.roleCss(scope, roles[0], roles[1])
        : kit.roleCss(scope, "transparent", "primary")),
      gap: "8px",
      ...outline,
      ...disabled.css,
    });
    const icon = hasIcon
      ? [
          (() => {
            const glyph = kit.icon({ type: "icon", name: node.icon }, scope, "");
            return { ...glyph, style: { ...glyph.style, width: "18px", height: "18px" } };
          })(),
        ]
      : [];
    return el("div", { attrs: { ...attrs, role: "button", ...disabled.attrs }, style }, [
      ...icon,
      el("span", { style: textCss({ textStyle: "labelLarge" }, scope.style) }, [
        kit.bound(node.label, scope),
      ]),
    ]);
  };
