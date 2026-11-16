import { checkWebAttributeName, checkWebTagName, type WebChild } from "../webNodes";

const SVG_NAMESPACE = "http://www.w3.org/2000/svg";

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
    ? document.createElementNS(SVG_NAMESPACE, node.tag)
    : document.createElement(node.tag);
  for (const [name, value] of Object.entries(node.attrs)) {
    checkWebAttributeName(name);
    element.setAttribute(name, value);
  }
  for (const [property, value] of Object.entries(node.style)) {
    element.style.setProperty(property, value);
  }
  element.append(...node.children.map((child) => buildPrototypeDom(document, child, svg)));
  return element;
}
