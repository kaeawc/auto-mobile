import { cssLength, type CssVars } from "./webCssLength";
import { shorthandValues, type WebRect } from "./webLayoutSize";
import type { WebElement } from "./webNodes";

/**
 * Rounded corners in the still's layout pass (#16707): a box with `border-radius` paints, and its
 * overflow clip shows, only inside its rounded border box, so a point in a corner's cut-away region
 * is outside the box.
 */

/** One corner's horizontal and vertical radius, in px. */
export interface CornerRadius {
  readonly x: number;
  readonly y: number;
}

/** A border box's four corner radii; a square corner is 0 by 0. */
export interface CornerRadii {
  readonly topLeft: CornerRadius;
  readonly topRight: CornerRadius;
  readonly bottomRight: CornerRadius;
  readonly bottomLeft: CornerRadius;
}

/** A border box and the radii that round it; no radii is a plain rectangle. */
export interface RoundedRect {
  readonly rect: WebRect;
  readonly radii?: CornerRadii;
}

type Corner = keyof CornerRadii;

/**
 * The longhands for each corner, physical then logical. The pass lays content out left to right,
 * so a logical corner maps as it does in a left-to-right window.
 */
const LONGHANDS: Record<Corner, readonly string[]> = {
  topLeft: ["border-top-left-radius", "border-start-start-radius"],
  topRight: ["border-top-right-radius", "border-start-end-radius"],
  bottomRight: ["border-bottom-right-radius", "border-end-end-radius"],
  bottomLeft: ["border-bottom-left-radius", "border-end-start-radius"],
};

const CORNERS: readonly Corner[] = ["topLeft", "topRight", "bottomRight", "bottomLeft"];

/** A corner's horizontal and vertical radius as CSS writes them; an absent vertical repeats it. */
type RadiusValues = readonly [string | undefined, string | undefined];

/** The `border-radius` shorthand's values for one corner, by its index in `CORNERS`. */
function shorthandCorner(value: string | undefined, index: number): RadiusValues {
  const [horizontal = "", vertical] = (value ?? "").split("/");
  const side = (part: string) => {
    const [tl, tr = tl, br = tl, bl = tr] = shorthandValues(part);
    return [tl, tr, br, bl][index];
  };
  return [side(horizontal), vertical === undefined ? undefined : side(vertical)];
}

/** A corner's radius; a value the pass cannot resolve (an unknown percentage base) is square. */
function cornerRadius(values: RadiusValues, rect: WebRect, vars: CssVars): CornerRadius {
  const [horizontal, vertical = horizontal] = values;
  const x = cssLength(horizontal, vars, rect.width) ?? 0;
  const y = cssLength(vertical, vars, rect.height) ?? 0;
  return x > 0 && y > 0 ? { x, y } : { x: 0, y: 0 };
}

/**
 * Scales every radius down by one factor when adjacent radii would overlap on a side
 * (CSS Backgrounds 3, 5.5). A side of unknown length does not constrain them.
 */
function fitted(radii: CornerRadii, rect: WebRect): CornerRadii {
  const { topLeft, topRight, bottomRight, bottomLeft } = radii;
  const sides: [number | undefined, number][] = [
    [rect.width, topLeft.x + topRight.x],
    [rect.width, bottomLeft.x + bottomRight.x],
    [rect.height, topLeft.y + bottomLeft.y],
    [rect.height, topRight.y + bottomRight.y],
  ];
  const factor = Math.min(
    1,
    ...sides.map(([length, sum]) => (length === undefined || sum <= 0 ? 1 : length / sum)),
  );
  if (factor >= 1) {
    return radii;
  }
  const scale = ({ x, y }: CornerRadius) => ({ x: x * factor, y: y * factor });
  return {
    topLeft: scale(topLeft),
    topRight: scale(topRight),
    bottomRight: scale(bottomRight),
    bottomLeft: scale(bottomLeft),
  };
}

/** An element's corner radii on its border box, or undefined when every corner is square. */
export function borderRadii(
  element: WebElement,
  rect: WebRect,
  vars: CssVars,
): CornerRadii | undefined {
  const radius = (corner: Corner): CornerRadius => {
    const longhand = LONGHANDS[corner]
      .map((name) => element.style[name])
      .find((value) => value !== undefined);
    const [x, y] = shorthandValues(longhand);
    const values: RadiusValues =
      longhand === undefined
        ? shorthandCorner(element.style["border-radius"], CORNERS.indexOf(corner))
        : [x, y];
    return cornerRadius(values, rect, vars);
  };
  const radii: CornerRadii = {
    topLeft: radius("topLeft"),
    topRight: radius("topRight"),
    bottomRight: radius("bottomRight"),
    bottomLeft: radius("bottomLeft"),
  };
  return CORNERS.every((corner) => radii[corner].x === 0) ? undefined : fitted(radii, rect);
}

/**
 * Whether the point (`x`, `y`) inside `rect` falls in a corner's cut-away region: inside the
 * corner's radius square but outside the ellipse quarter that rounds it.
 */
export function inCutCorner(
  radii: CornerRadii,
  rect: { left: number; top: number; width: number; height: number | undefined },
  x: number,
  y: number,
): boolean {
  const right = rect.left + rect.width;
  const bottom = rect.height === undefined ? undefined : rect.top + rect.height;
  // `inward` points from the corner into the box on each axis: +1 from a left or top edge.
  const cut = (
    { x: rx, y: ry }: CornerRadius,
    [cornerX, inwardX]: [number, 1 | -1],
    [cornerY, inwardY]: [number | undefined, 1 | -1],
  ) => {
    if (rx <= 0 || ry <= 0 || cornerY === undefined) {
      return false;
    }
    // The ellipse's centre sits one radius in from the corner on each axis.
    const dx = (x - (cornerX + inwardX * rx)) * inwardX;
    const dy = (y - (cornerY + inwardY * ry)) * inwardY;
    return dx < 0 && dy < 0 && (dx / rx) ** 2 + (dy / ry) ** 2 > 1;
  };
  return (
    cut(radii.topLeft, [rect.left, 1], [rect.top, 1]) ||
    cut(radii.topRight, [right, -1], [rect.top, 1]) ||
    cut(radii.bottomRight, [right, -1], [bottom, -1]) ||
    cut(radii.bottomLeft, [rect.left, 1], [bottom, -1])
  );
}
