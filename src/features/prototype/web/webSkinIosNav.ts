import type { Raw } from "../prototypeTemplate";
import {
  barBase,
  navIcon,
  navItems,
  navSelection,
  withBottomInset,
  type NavItem,
} from "./webControls";
import { el, type WebElement } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import { iosRole, iosText } from "./webSkinIos";

type Css = Record<string, string>;

/**
 * A nav item's colour as the iOS renderer picks it: `onSecondaryContainer` when selected (else the
 * system accent), `onSurfaceVariant` otherwise (else the secondary label colour).
 */
function navForeground(selected: boolean, scope: WebRenderScope): string {
  const dark = scope.style.mode === "dark";
  return selected
    ? iosRole("onSecondaryContainer", dark ? "rgba(10,132,255,1)" : "rgba(0,122,255,1)", scope)
    : iosRole("onSurfaceVariant", dark ? "rgba(235,235,245,0.6)" : "rgba(60,60,67,0.6)", scope);
}

/** The selected item's capsule: `secondaryContainer`, else none. */
function indicator(selected: boolean, scope: WebRenderScope): Css {
  return selected
    ? { "background-color": iosRole("secondaryContainer", "transparent", scope) }
    : {};
}

/**
 * The bottom bar's item: its visual in a 64x32 capsule over a one-line `.caption` label (semibold
 * when selected, else medium), 4 pt apart, centred in at least 64 pt.
 */
function bottomNavItem(item: NavItem, selected: boolean, scope: WebRenderScope, kit: WebRenderKit) {
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
        ...indicator(selected, scope),
      },
    },
    [navIcon(item, scope, kit)],
  );
  const label = el(
    "span",
    {
      style: {
        ...iosText("caption", scope, selected ? 600 : 500),
        "white-space": "nowrap",
        overflow: "hidden",
        "text-overflow": "ellipsis",
        "max-width": "100%",
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
        "justify-content": "center",
        gap: "4px",
        flex: "1 1 0",
        "min-width": "0",
        "min-height": "64px",
        color: navForeground(selected, scope),
      },
    },
    [pill, label],
  );
}

/**
 * A bottom navigation bar as the iOS renderer draws one: items 8 pt apart, padded 8 pt at the sides,
 * 12 pt above and 4 pt below (plus the bottom inset), on `surfaceContainer`, else the secondary
 * system background.
 */
export const iosBottomNavRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const items = navItems(node, scope, kit);
    const selected = navSelection(node, items.length, scope, kit);
    const dark = scope.style.mode === "dark";
    const { attrs, style: barStyle } = barBase(node, scope, kit, {
      "min-height": "80px",
      gap: "8px",
      "padding-inline": "8px",
      "padding-top": "12px",
      "padding-bottom": "4px",
      "box-sizing": "border-box",
      "background-color": iosRole(
        "surfaceContainer",
        dark ? "rgba(28,28,30,1)" : "rgba(242,242,247,1)",
        scope,
      ),
    });
    const style = withBottomInset(node, scope, kit, barStyle);
    return el(
      "div",
      { attrs: { ...attrs, role: "tablist" }, style },
      items.map((item, index) => bottomNavItem(item, index === selected, scope, kit)),
    );
  };

interface TabLayout {
  readonly minHeight: string;
  readonly scope: WebRenderScope;
  readonly kit: WebRenderKit;
}

/** A tab: its visual over a `.caption` label, 2 pt apart, in a capsule when selected. */
function tab(item: NavItem, selected: boolean, { minHeight, scope, kit }: TabLayout) {
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
        flex: "1 1 0",
        "min-width": "0",
        "min-height": minHeight,
        "border-radius": "9999px",
        ...iosText("caption", scope),
        color: navForeground(selected, scope),
        ...indicator(selected, scope),
      },
    },
    [...visual, item.label],
  );
}

/**
 * A tab bar as the iOS renderer draws one: equal tabs with no spacing, background or divider, at
 * least 44 pt tall (64 pt when it minimizes on scroll), the selected one in a capsule.
 */
export const iosTabBarRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node: Raw, scope) => {
    const items = navItems(node, scope, kit);
    const selected = navSelection(node, items.length, scope, kit);
    const layout: TabLayout = {
      minHeight: node.onScroll === "minimize" ? "64px" : "44px",
      scope,
      kit,
    };
    const { attrs, style } = barBase(node, scope, kit, {});
    const tabs: WebElement[] = items.map((item, index) => tab(item, index === selected, layout));
    return el("div", { attrs: { ...attrs, role: "tablist" }, style }, tabs);
  };
