import { record } from "../prototypeTemplate";
import { el, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";

/** App-bar navigation and action slots draw as icon placeholders labelled with their action. */
export function appBarIcons(
  kit: WebRenderKit,
  slots: readonly unknown[],
  scope: WebRenderScope,
  path: string,
): WebElement[] {
  return slots.flatMap((slot) => {
    const action = record(slot);
    if (typeof action?.icon !== "string") {
      return [];
    }
    const glyph = kit.icon({ type: "icon", name: action.icon }, scope, path);
    const label = typeof action.label === "string" ? kit.bound(action.label, scope) : action.icon;
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

/** The Material 3 top app bar. */
export function webAppBarRenderers(kit: WebRenderKit): Readonly<Record<string, NodeRenderer>> {
  const topAppBar: NodeRenderer = (node, scope, path) => {
    const variant = typeof node.variant === "string" ? node.variant : "small";
    const size = APP_BAR_VARIANTS[variant] ?? APP_BAR_VARIANTS.small!;
    const expanded = variant === "medium" || variant === "large";
    const { attrs, style } = kit.base(node, scope, {
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
      ...kit.roleCss(scope, "surface", "onSurface"),
    });
    const actions = Array.isArray(node.actions) ? node.actions : [];
    const title = el("span", { style: appBarTitleStyle(variant, expanded) }, [
      kit.bound(node.title, scope),
    ]);
    return el("div", { attrs: { ...attrs, role: "heading" }, style }, [
      ...appBarIcons(kit, [node.navigationIcon], scope, path),
      title,
      // When the title leaves the flow (its own line, or centred on the bar), a spacer keeps the
      // actions at the end.
      ...(expanded || variant === "centerAligned"
        ? [el("span", { style: { flex: "1 1 auto" } })]
        : []),
      ...appBarIcons(kit, actions, scope, path),
    ]);
  };
  return { topAppBar };
}
