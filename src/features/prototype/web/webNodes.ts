/**
 * A small element tree the prototype web renderer builds (#16346). It serializes to the same
 * bytes for the same tree: attributes and style properties are written in sorted order, so the
 * exported page is deterministic.
 */
export interface WebElement {
  readonly tag: string;
  readonly attrs: Readonly<Record<string, string>>;
  readonly style: Readonly<Record<string, string>>;
  readonly children: readonly WebChild[];
}
export type WebChild = WebElement | string;

export function el(
  tag: string,
  options: { attrs?: Record<string, string>; style?: Record<string, string> } = {},
  children: readonly WebChild[] = [],
): WebElement {
  return { tag, attrs: options.attrs ?? {}, style: options.style ?? {}, children };
}

const VOID_ELEMENTS = new Set(["img", "br", "hr", "input", "meta", "link"]);
const NAME = /^[a-z][a-z0-9-]*$/;
/** The camelCase SVG attributes inline glyphs and map overlays need; no other mixed case passes. */
const SVG_ATTRIBUTES = new Set(["viewBox", "preserveAspectRatio"]);

function escapeText(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

export function escapeAttribute(text: string): string {
  return escapeText(text).replace(/"/g, "&quot;");
}

function sortedEntries(values: Readonly<Record<string, string>>): [string, string][] {
  return Object.entries(values).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
}

function attributeText(element: WebElement): string {
  const style = sortedEntries(element.style)
    .map(([property, value]) => `${property}:${value}`)
    .join(";");
  const attrs = { ...element.attrs, ...(style ? { style } : {}) };
  return sortedEntries(attrs)
    .map(([name, value]) => {
      if (!NAME.test(name) && !SVG_ATTRIBUTES.has(name)) {
        throw new Error(`Invalid attribute name: ${name}`);
      }
      // The page runs no authored script; handlers would bypass the CSP's script hashes.
      if (name.toLowerCase().startsWith("on")) {
        throw new Error(`Event handler attributes are not allowed: ${name}`);
      }
      return ` ${name}="${escapeAttribute(value)}"`;
    })
    .join("");
}

export function toHtml(node: WebChild): string {
  if (typeof node === "string") {
    return escapeText(node);
  }
  if (!NAME.test(node.tag)) {
    throw new Error(`Invalid element name: ${node.tag}`);
  }
  const open = `<${node.tag}${attributeText(node)}>`;
  if (VOID_ELEMENTS.has(node.tag)) {
    return open;
  }
  return `${open}${node.children.map(toHtml).join("")}</${node.tag}>`;
}
