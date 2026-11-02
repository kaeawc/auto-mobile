import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  toHtml,
  type WebChild,
  type WebElement,
} from "../../../../src/features/prototype/web/webNodes";
import { renderPrototypeStill } from "../../../../src/features/prototype/web/webStill";

const reference = JSON.parse(
  readFileSync(
    join(import.meta.dir, "../../../fixtures/prototype-web/reference-checkout.json"),
    "utf8",
  ),
) as Record<string, unknown>;

function find(node: WebChild, predicate: (element: WebElement) => boolean): WebElement[] {
  if (typeof node === "string") {
    return [];
  }
  return [
    ...(predicate(node) ? [node] : []),
    ...node.children.flatMap((child) => find(child, predicate)),
  ];
}
const textOf = (node: WebChild): string =>
  typeof node === "string" ? node : node.children.map(textOf).join("");
const byTag = (still: { element: WebElement }, tag: string) =>
  find(still.element, (element) => element.attrs["data-testid"] === tag);

describe("prototype web still (#16346)", () => {
  const still = renderPrototypeStill(reference, { frame: "pixel-9" });
  const html = toHtml(still.element);

  test("binds state, top-level derived values and repeat items with their derived fields", () => {
    expect(html).toContain("Hi Ada");
    expect(html).toContain("Total $42.50");
    expect(textOf(byTag(still, "lines")[0]!)).toBe("Tea: $3.00Cake: $4.25");
  });

  test("shows the stack's start screen only", () => {
    expect(html).not.toContain("Thanks");
  });

  test("hides a node whose visibleWhen does not hold", () => {
    expect(byTag(still, "promo")).toEqual([]);
  });

  test("draws controls from spec state", () => {
    const checkbox = find(still.element, (element) => element.attrs.role === "checkbox");
    expect(checkbox.map((element) => element.attrs["aria-checked"])).toEqual(["true"]);
  });

  test("resolves theme roles to colours", () => {
    expect(html).toContain("color:rgba(103,80,164,1)");
  });

  test("lists unsupported nodes with their paths and draws a labelled placeholder", () => {
    expect(still.unsupportedNodes).toEqual([
      {
        type: "progress",
        id: "spend",
        path: 'root.screens["cart"].children[5]',
        reason: "unsupportedType",
      },
    ]);
    expect(
      find(still.element, (element) => element.attrs["data-unsupported"] === "progress"),
    ).toHaveLength(1);
  });

  test("the same input renders the same bytes", () => {
    expect(toHtml(renderPrototypeStill(reference, { frame: "pixel-9" }).element)).toBe(html);
  });

  test("dark mode resolves the dark palette", () => {
    const dark = toHtml(
      renderPrototypeStill(reference, { frame: "pixel-9", mode: "dark" }).element,
    );
    expect(dark).toContain("color:rgba(208,188,255,1)");
  });

  test("an image draws a placeholder and is listed as not inlined", () => {
    const spec = { ...reference, root: { type: "image", id: "hero", asset: "hero" } };
    expect(renderPrototypeStill(spec).unsupportedNodes).toEqual([
      { type: "image", id: "hero", path: "root", reason: "assetNotInlined" },
    ]);
  });

  for (const frame of ["pixel-9", "iphone-16"]) {
    for (const orientation of ["portrait", "landscape"] as const) {
      test(`snapshot on ${frame} in ${orientation}`, () => {
        expect(
          toHtml(renderPrototypeStill(reference, { frame, orientation }).element),
        ).toMatchSnapshot();
      });
    }
  }
});
