import { el } from "./webNodes";
import type { NodeRenderer, WebRenderKit } from "./webRender";
import { cssColor } from "./webStyle";

/** Material 3 button containers: [background role, label role]; outlined and text have none. */
const BUTTON_ROLES: Readonly<Record<string, [string, string]>> = {
  filled: ["primary", "onPrimary"],
  tonal: ["secondaryContainer", "onSecondaryContainer"],
  elevated: ["surfaceContainerLow", "primary"],
};

/** A Material 3 button: a 40 px pill with its variant's container and an optional leading icon. */
export const materialButtonRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const disabled = kit.disabledState(node, scope);
    const variant = typeof node.variant === "string" ? node.variant : "filled";
    const roles = BUTTON_ROLES[variant];
    const outline: Record<string, string> =
      variant === "outlined"
        ? { border: `1px solid ${cssColor("outline", scope.style) ?? "currentColor"}` }
        : {};
    const { attrs, style } = kit.base(node, scope, {
      display: "inline-flex",
      "align-items": "center",
      "justify-content": "center",
      "min-height": "40px",
      padding: "0 24px",
      "border-radius": "20px",
      "font-weight": "500",
      ...(roles
        ? kit.roleCss(scope, roles[0], roles[1])
        : kit.roleCss(scope, "transparent", "primary")),
      gap: "8px",
      ...outline,
      ...disabled.css,
    });
    const icon =
      typeof node.icon === "string" ? [kit.icon({ type: "icon", name: node.icon }, scope, "")] : [];
    return el("div", { attrs: { ...attrs, role: "button", ...disabled.attrs }, style }, [
      ...icon,
      kit.bound(node.label, scope),
    ]);
  };
