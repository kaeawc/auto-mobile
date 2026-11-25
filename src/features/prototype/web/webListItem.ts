import {
  ALIGN_ITEMS,
  ALIGN_SELF,
  ARIA_CHECKED,
  CENTER,
  COLUMN,
  FLEX,
  FLEX_DIRECTION,
  MIN_HEIGHT,
  STRETCH,
} from "./webCss";
import { record, type Raw } from "../prototypeTemplate";
import { el, type WebChild } from "./webNodes";
import type { NodeRenderer, WebRenderKit, WebRenderScope } from "./webRender";
import { textCss } from "./webStyle";
import { toggleMark } from "./webToggleMark";

/** A list item's trailing switch, checkbox or icon; a disabled item disables its control too. */
function trailing(
  node: Raw,
  scope: WebRenderScope,
  disabledAttrs: Record<string, string>,
  kit: WebRenderKit,
): WebChild[] {
  const entry = record(node.trailing);
  if (entry?.type === "switch" || entry?.type === "checkbox") {
    const key = typeof entry.stateKey === "string" ? kit.bound(entry.stateKey, scope) : undefined;
    const on = key !== undefined && scope.condition.state[key] === true;
    return [
      el(
        "span",
        {
          attrs: { role: entry.type, [ARIA_CHECKED]: String(on), ...disabledAttrs },
          style: { display: FLEX },
        },
        [toggleMark(entry.type, on, scope)],
      ),
    ];
  }
  if (entry?.type === "icon") {
    return [kit.icon({ type: "icon", name: entry.name }, scope, "")];
  }
  return [];
}

/**
 * Material 3's ListItem, as Android draws it: a `surface` container with 16 px either side and
 * 16 px between the leading icon, the text and the trailing content; a `bodyLarge` headline over
 * a `bodyMedium` supporting line in `onSurfaceVariant`, as is the leading icon. One line is at
 * least 56 px tall with 8 px above and below; with a supporting line, at least 72 px with 12 px,
 * which a supporting line that wraps grows toward the three-line 88 px (#16611). An authored
 * background or foreground replaces the container's and the text's colours, as on Android.
 */
export const listItemRenderer =
  (kit: WebRenderKit): NodeRenderer =>
  (node, scope) => {
    const disabled = kit.disabledState(node, scope);
    const twoLine = node.supporting !== undefined;
    const { attrs, style } = kit.base(node, scope, {
      display: FLEX,
      [ALIGN_ITEMS]: CENTER,
      gap: "16px",
      [MIN_HEIGHT]: twoLine ? "72px" : "56px",
      padding: twoLine ? "12px 16px" : "8px 16px",
      [ALIGN_SELF]: STRETCH,
      ...kit.roleCss(scope, "surface", "onSurface"),
      ...disabled.css,
    });
    const variant: Record<string, string> =
      record(node.style)?.color === undefined
        ? kit.roleCss(scope, "transparent", "onSurfaceVariant")
        : {};
    const supporting =
      node.supporting === undefined
        ? []
        : [
            el(
              "span",
              { style: { ...textCss({ textStyle: "bodyMedium" }, scope.style), ...variant } },
              [kit.bound(node.supporting, scope)],
            ),
          ];
    const texts = el(
      "div",
      { style: { display: FLEX, [FLEX_DIRECTION]: COLUMN, flex: "1 1 auto" } },
      [
        el("span", { style: textCss({ textStyle: "bodyLarge" }, scope.style) }, [
          kit.bound(node.headline, scope),
        ]),
        ...supporting,
      ],
    );
    const leading = (
      typeof node.leadingIcon === "string"
        ? [kit.icon({ type: "icon", name: node.leadingIcon }, scope, "")]
        : []
    ).map((glyph) => ({
      ...glyph,
      style: { ...glyph.style, ...(variant.color ? { color: variant.color } : {}) },
    }));
    return el("div", { attrs: { ...attrs, role: "listitem", ...disabled.attrs }, style }, [
      ...leading,
      texts,
      ...trailing(node, scope, disabled.attrs, kit),
    ]);
  };
