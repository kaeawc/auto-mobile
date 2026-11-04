import {
  ALIGN_ITEMS,
  BACKGROUND_COLOR,
  BORDER_BOX,
  BORDER_RADIUS,
  BOX_SIZING,
  CENTER,
  DATA_PART,
  FLEX,
  FLEX_SHRINK,
  MARGIN_INLINE_START,
} from "./webCss";
import { el, type WebElement } from "./webNodes";
import { cssColor, type WebStyleContext } from "./webStyle";

/** The part of a render scope the colour helpers read. */
type StyledScope = { readonly style: WebStyleContext };

/** Background and text colour from two theme roles; a role that does not resolve is left out. */
export function roleCss(
  scope: StyledScope,
  background: string,
  foreground: string,
): Record<string, string> {
  const css: Record<string, string> = {};
  const bg = cssColor(background, scope.style);
  const fg = cssColor(foreground, scope.style);
  if (bg) {
    css[BACKGROUND_COLOR] = bg;
  }
  if (fg) {
    css.color = fg;
  }
  return css;
}

/**
 * A Material 3 switch: a 52x32 track with a thumb at the end when on (24 px, onPrimary on primary)
 * and at the start when off (16 px, outline on surfaceContainerHighest inside an outline border).
 */
function switchMark(on: boolean, scope: StyledScope): WebElement {
  const outline = cssColor("outline", scope.style) ?? "currentColor";
  const thumb = el("span", {
    attrs: { [DATA_PART]: "thumb" },
    style: {
      width: on ? "24px" : "16px",
      height: on ? "24px" : "16px",
      [BORDER_RADIUS]: "50%",
      [BACKGROUND_COLOR]: on ? (cssColor("onPrimary", scope.style) ?? "#fff") : outline,
      ...(on ? { [MARGIN_INLINE_START]: "auto" } : {}),
    },
  });
  return el(
    "span",
    {
      style: {
        display: FLEX,
        [ALIGN_ITEMS]: CENTER,
        [BOX_SIZING]: BORDER_BOX,
        width: "52px",
        height: "32px",
        padding: on ? "0 4px" : "0 6px",
        [BORDER_RADIUS]: "16px",
        [FLEX_SHRINK]: "0",
        border: `2px solid ${on ? "transparent" : outline}`,
        ...roleCss(scope, on ? "primary" : "surfaceContainerHighest", "onPrimary"),
      },
    },
    [thumb],
  );
}

/** A switch track or checkbox box, drawn from whether its state is on. */
export function toggleMark(
  role: "switch" | "checkbox",
  on: boolean,
  scope: StyledScope,
): WebElement {
  return role === "switch"
    ? switchMark(on, scope)
    : el("span", {
        style: {
          width: "18px",
          height: "18px",
          [BORDER_RADIUS]: "2px",
          [FLEX_SHRINK]: "0",
          border: `2px solid ${cssColor(on ? "primary" : "onSurfaceVariant", scope.style) ?? "currentColor"}`,
          ...(on ? roleCss(scope, "primary", "onPrimary") : {}),
        },
      });
}
