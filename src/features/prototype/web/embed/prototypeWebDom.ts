import { checkWebAttributeName, checkWebTagName, type WebChild } from "../webNodes";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

/** Keys each camelCase name by its lowercase form. */
const byLowercase = (names: readonly string[]): ReadonlyMap<string, string> =>
  new Map(names.map((name) => [name.toLowerCase(), name]));

/**
 * The HTML parser's SVG case adjustments (HTML spec, "adjust SVG attributes" and the SVG tag name
 * table). Builders write these names lowercase and `toHtml` relies on the parser to restore them;
 * `createElementNS` does no such thing, so the DOM builder restores them itself.
 */
const SVG_ATTRIBUTE_CASE = byLowercase([
  "attributeName",
  "attributeType",
  "baseFrequency",
  "baseProfile",
  "calcMode",
  "clipPathUnits",
  "diffuseConstant",
  "edgeMode",
  "filterUnits",
  "glyphRef",
  "gradientTransform",
  "gradientUnits",
  "kernelMatrix",
  "kernelUnitLength",
  "keyPoints",
  "keySplines",
  "keyTimes",
  "lengthAdjust",
  "limitingConeAngle",
  "markerHeight",
  "markerUnits",
  "markerWidth",
  "maskContentUnits",
  "maskUnits",
  "numOctaves",
  "pathLength",
  "patternContentUnits",
  "patternTransform",
  "patternUnits",
  "pointsAtX",
  "pointsAtY",
  "pointsAtZ",
  "preserveAlpha",
  "preserveAspectRatio",
  "primitiveUnits",
  "refX",
  "refY",
  "repeatCount",
  "repeatDur",
  "requiredExtensions",
  "requiredFeatures",
  "specularConstant",
  "specularExponent",
  "spreadMethod",
  "startOffset",
  "stdDeviation",
  "stitchTiles",
  "surfaceScale",
  "systemLanguage",
  "tableValues",
  "targetX",
  "targetY",
  "textLength",
  "viewBox",
  "viewTarget",
  "xChannelSelector",
  "yChannelSelector",
  "zoomAndPan",
]);
const SVG_TAG_CASE = byLowercase([
  "altGlyph",
  "altGlyphDef",
  "altGlyphItem",
  "animateColor",
  "animateMotion",
  "animateTransform",
  "clipPath",
  "feBlend",
  "feColorMatrix",
  "feComponentTransfer",
  "feComposite",
  "feConvolveMatrix",
  "feDiffuseLighting",
  "feDisplacementMap",
  "feDistantLight",
  "feDropShadow",
  "feFlood",
  "feFuncA",
  "feFuncB",
  "feFuncG",
  "feFuncR",
  "feGaussianBlur",
  "feImage",
  "feMerge",
  "feMergeNode",
  "feMorphology",
  "feOffset",
  "fePointLight",
  "feSpecularLighting",
  "feSpotLight",
  "feTile",
  "feTurbulence",
  "foreignObject",
  "glyphRef",
  "linearGradient",
  "radialGradient",
  "textPath",
]);

/** The DOM a built element needs: what an HTML or SVG `Element` exposes, narrowed. */
export interface PrototypeDomElement {
  setAttribute(name: string, value: string): void;
  append(...nodes: PrototypeDomNode[]): void;
  readonly style: { setProperty(name: string, value: string): void };
}
export type PrototypeDomNode = PrototypeDomElement | object;

/** The document calls the builder makes: a DOM `Document`, narrowed. */
export interface PrototypeDomDocument {
  createElement(tag: string): PrototypeDomElement;
  createElementNS(namespace: string, tag: string): PrototypeDomElement;
  createTextNode(text: string): PrototypeDomNode;
}

/**
 * Builds the renderer's element tree as DOM nodes with `createElement`, `setAttribute` and
 * `style.setProperty`, never `innerHTML`, so a host page with a strict CSP or Trusted Types can
 * embed it (#16453). Names are checked as `toHtml` checks them, so neither path writes a handler.
 */
export function buildPrototypeDom(
  document: PrototypeDomDocument,
  node: WebChild,
  inSvg = false,
): PrototypeDomNode {
  if (typeof node === "string") {
    return document.createTextNode(node);
  }
  checkWebTagName(node.tag);
  const svg = inSvg || node.tag === "svg";
  const element = svg
    ? document.createElementNS(SVG_NAMESPACE, SVG_TAG_CASE.get(node.tag) ?? node.tag)
    : document.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    checkWebAttributeName(name);
    element.setAttribute(svg ? (SVG_ATTRIBUTE_CASE.get(name) ?? name) : name, value);
  }
  for (const [property, value] of Object.entries(node.style)) {
    element.style.setProperty(property, value);
  }
  element.append(...node.children.map((child) => buildPrototypeDom(document, child, svg)));
  return element;
}
