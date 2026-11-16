import { describe, expect, test } from "bun:test";
import {
  buildPrototypeDom,
  type PrototypeDomDocument,
  type PrototypeDomElement,
  type PrototypeDomNode,
} from "../../../../../src/features/prototype/web/embed/prototypeWebDom";
import { el } from "../../../../../src/features/prototype/web/webNodes";

/** A recording DOM: each element keeps its namespace, attributes, style calls and children. */
class FakeElement implements PrototypeDomElement {
  readonly attributes: Record<string, string> = {};
  readonly styles: [string, string][] = [];
  readonly children: PrototypeDomNode[] = [];
  readonly style = {
    setProperty: (name: string, value: string) => void this.styles.push([name, value]),
  };

  constructor(
    readonly tag: string,
    readonly namespace: string | undefined,
  ) {}

  setAttribute(name: string, value: string) {
    this.attributes[name] = value;
  }

  append(...nodes: PrototypeDomNode[]) {
    this.children.push(...nodes);
  }
}

const fakeDocument: PrototypeDomDocument = {
  createElement: (tag) => new FakeElement(tag, undefined),
  createElementNS: (namespace, tag) => new FakeElement(tag, namespace),
  createTextNode: (text) => ({ text }),
};

describe("buildPrototypeDom (#16453)", () => {
  test("sets attributes and style properties and appends text", () => {
    const built = buildPrototypeDom(
      fakeDocument,
      el("div", { attrs: { "data-view": "" }, style: { "--fade-mask": "none", color: "red" } }, [
        "Hi <b>",
      ]),
    );
    expect(built).toMatchObject({
      tag: "div",
      namespace: undefined,
      attributes: { "data-view": "" },
      styles: [
        ["--fade-mask", "none"],
        ["color", "red"],
      ],
      children: [{ text: "Hi <b>" }],
    });
  });

  test("builds an svg and everything inside it in the SVG namespace", () => {
    const built = buildPrototypeDom(
      fakeDocument,
      el("span", {}, [
        el("svg", { attrs: { viewBox: "0 0 24 24" } }, [el("path", { attrs: { d: "M0 0" } })]),
      ]),
    );
    const svg = (built as FakeElement).children[0] as FakeElement;
    expect(svg.namespace).toBe("http://www.w3.org/2000/svg");
    expect((svg.children[0] as FakeElement).namespace).toBe("http://www.w3.org/2000/svg");
    expect(svg.attributes).toEqual({ viewBox: "0 0 24 24" });
  });

  test("refuses event handler attributes and invalid names, as toHtml does", () => {
    expect(() => buildPrototypeDom(fakeDocument, el("div", { attrs: { onclick: "x" } }))).toThrow(
      "Event handler attributes are not allowed: onclick",
    );
    expect(() => buildPrototypeDom(fakeDocument, el("Script"))).toThrow(
      "Invalid element name: Script",
    );
  });
});
