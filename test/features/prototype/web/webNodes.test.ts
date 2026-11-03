import { expect, test } from "bun:test";
import { el, toHtml } from "../../../../src/features/prototype/web/webNodes";

test("serializes attributes and styles in sorted order", () => {
  const node = el(
    "div",
    { style: { width: "4px", color: "red" }, attrs: { role: "img", "aria-label": "x" } },
    ["hi"],
  );
  expect(toHtml(node)).toBe('<div aria-label="x" role="img" style="color:red;width:4px">hi</div>');
});

test("escapes text and attribute values", () => {
  const node = el("span", { attrs: { title: '"<&>' } }, ["<b>&</b>"]);
  expect(toHtml(node)).toBe('<span title="&quot;&lt;&amp;&gt;">&lt;b&gt;&amp;&lt;/b&gt;</span>');
});

test("omits empty style and writes void elements without a closing tag", () => {
  expect(toHtml(el("img", { attrs: { alt: "" } }))).toBe('<img alt="">');
  expect(toHtml(el("div", { style: {} }))).toBe("<div></div>");
});

test("rejects an unsafe tag or attribute name", () => {
  expect(() => toHtml(el("scr ipt"))).toThrow("Invalid element name");
  expect(() => toHtml(el("div", { attrs: { "on click": "x" } }))).toThrow("Invalid attribute name");
  expect(() => toHtml(el("div", { attrs: { onclick: "x" } }))).toThrow("Event handler attributes");
});

test("allows only the named camelCase SVG attributes", () => {
  expect(toHtml(el("svg", { attrs: { viewBox: "0 0 24 24" } }))).toBe(
    '<svg viewBox="0 0 24 24"></svg>',
  );
  expect(() => toHtml(el("div", { attrs: { onClick: "x" } }))).toThrow("Invalid attribute name");
});
