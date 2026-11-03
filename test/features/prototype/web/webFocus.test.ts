import { describe, expect, test } from "bun:test";
import { markInitialFocus } from "../../../../src/features/prototype/web/webFocus";
import {
  el,
  type WebChild,
  type WebElement,
} from "../../../../src/features/prototype/web/webNodes";

const node = (type: string, role?: string, extra: Record<string, string> = {}) =>
  el("div", { attrs: { "data-node": type, ...(role ? { role } : {}), ...extra } }, [type]);

const ringed = (root: WebChild): string[] =>
  typeof root === "string"
    ? []
    : [
        ...(root.attrs["data-focus"] === "ring" ? [root.attrs["data-node"] ?? root.tag] : []),
        ...root.children.flatMap(ringed),
      ];

describe("markInitialFocus (#16446)", () => {
  test("rings the first focusable spec node in document order, and only that one", () => {
    const tree = el("div", {}, [
      node("text"),
      el("div", {}, [node("heading", "heading"), node("chip", "button")]),
      node("button", "button"),
    ]);
    const marked = markInitialFocus(tree);
    expect(ringed(marked)).toEqual(["chip"]);
    const chip = (marked.children[1] as WebElement).children[1] as WebElement;
    expect(chip.style).toMatchObject({ outline: "3px solid #ffffff", "outline-offset": "2px" });
  });

  test("skips disabled nodes and role-bearing parts that are not spec nodes", () => {
    const tree = el("div", {}, [
      node("button", "button", { "aria-disabled": "true" }),
      el("span", { attrs: { role: "button" } }, ["clear"]),
      node("textField", "textbox"),
    ]);
    expect(ringed(markInitialFocus(tree))).toEqual(["textField"]);
  });

  test("an item of a spec tab list takes focus; a stray tab outside one does not", () => {
    const tab = (label: string) => el("div", { attrs: { role: "tab" } }, [label]);
    const tablist = el("div", { attrs: { "data-node": "tabBar", role: "tablist" } }, [
      tab("first"),
      tab("second"),
    ]);
    const marked = markInitialFocus(el("div", {}, [tab("stray"), tablist]));
    const items = (marked.children[1] as WebElement).children as WebElement[];
    expect(items.map((item) => item.attrs["data-focus"] ?? "none")).toEqual(["ring", "none"]);
    expect((marked.children[0] as WebElement).attrs["data-focus"]).toBeUndefined();
  });

  test("each focusable role can take focus", () => {
    for (const role of ["button", "checkbox", "switch", "slider", "tab", "textbox"]) {
      expect(ringed(markInitialFocus(el("div", {}, [node(role, role)])))).toEqual([role]);
    }
  });

  test("a tree with nothing focusable comes back unchanged", () => {
    const tree = el("div", {}, [node("text"), node("image", "img")]);
    expect(markInitialFocus(tree)).toBe(tree);
  });
});
