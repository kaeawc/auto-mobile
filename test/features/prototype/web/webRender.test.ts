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

  test("expands a literal repeat items array", () => {
    const spec = {
      ...reference,
      root: {
        type: "column",
        testTag: "literal",
        repeat: { as: "item", items: [{ t: "x" }, { t: "y" }] },
        children: [{ type: "text", text: "{item.t}" }],
      },
    };
    expect(textOf(byTag(renderPrototypeStill(spec), "literal")[0]!)).toBe("xy");
  });

  test("binds repeat placeholders in control state keys before reading state", () => {
    const spec = {
      ...reference,
      state: { selected_a: true, selected_b: false, name_a: "Ada" },
      root: {
        type: "column",
        repeat: { as: "item", items: [{ id: "a" }, { id: "b" }] },
        children: [
          { type: "checkbox", stateKey: "selected_{item.id}", label: "{item.id}" },
          { type: "textField", stateKey: "name_{item.id}", placeholder: "Name" },
        ],
      },
    };
    const still = renderPrototypeStill(spec);
    const fields = find(still.element, (element) => element.attrs.role === "textbox");
    expect(fields.map(textOf)).toEqual(["Ada", "Name"]);
    const checked = find(still.element, (element) => element.attrs.role === "checkbox");
    expect(checked.map((element) => element.attrs["aria-checked"])).toEqual(["true", "false"]);
  });

  test("renders a spans-only text node with each span's style", () => {
    const spec = {
      ...reference,
      root: {
        type: "text",
        testTag: "rich",
        spans: [{ text: "Hi {name}, " }, { text: "bold", style: { fontWeight: 700 } }],
      },
    };
    const rich = byTag(renderPrototypeStill(spec), "rich")[0]!;
    expect(textOf(rich)).toBe("Hi Ada, bold");
    expect(toHtml(rich)).toContain('<span style="font-weight:700">bold</span>');
  });

  test("the spec's own style wins over a control's defaults", () => {
    const spec = {
      ...reference,
      root: {
        type: "button",
        testTag: "pay",
        label: "Pay",
        onTap: [{ type: "setState", key: "agree", value: false }],
        style: { color: "#FF0000", cornerRadius: 0, fontWeight: 900 },
      },
    };
    expect(byTag(renderPrototypeStill(spec), "pay")[0]!.style).toMatchObject({
      color: "rgba(255,0,0,1)",
      "border-radius": "0px",
      "font-weight": "900",
    });
  });

  test("binds repeat placeholders inside nested conditions and typed operands", () => {
    const spec = {
      ...reference,
      state: { selected_a: false, selected_b: true, current: "b" },
      root: {
        type: "column",
        repeat: { as: "item", items: [{ id: "a" }, { id: "b" }] },
        children: [
          {
            type: "text",
            text: "nested {item.id}",
            visibleWhen: { all: [{ key: "selected_{item.id}", equals: true }] },
          },
          {
            type: "text",
            text: "operand {item.id}",
            visibleWhen: { key: "current", equals: "{item.id}" },
          },
        ],
      },
    };
    const html = toHtml(renderPrototypeStill(spec).element);
    expect(html).not.toContain("nested a");
    expect(html).toContain("nested b");
    expect(html).not.toContain("operand a");
    expect(html).toContain("operand b");
  });

  test("masks a secure or password text field's value", () => {
    const field = (extra: Record<string, unknown>) => ({
      ...reference,
      state: { password: "secret123" },
      root: { type: "textField", testTag: "pw", stateKey: "password", ...extra },
    });
    for (const extra of [{ secure: true }, { keyboardType: "password" }]) {
      const html = toHtml(renderPrototypeStill(field(extra)).element);
      expect(html).not.toContain("secret123");
      expect(textOf(byTag(renderPrototypeStill(field(extra)), "pw")[0]!)).toBe("•••••••••");
    }
  });

  test("places a sheet at its edge with its height, and a floating window at its gravity", () => {
    const windowOf = (placement: Record<string, unknown>) =>
      find(
        renderPrototypeStill({ ...reference, window: { placement } }).element,
        (element) => element.attrs["data-window"] !== undefined,
      )[0]!;
    const top = windowOf({ type: "sheet", edge: "top", height: 200 });
    expect(top.style["justify-content"]).toBe("flex-start");
    expect((top.children[0] as { style: Record<string, string> }).style.height).toBe("200px");
    expect(windowOf({ type: "sheet", edge: "bottom", height: 120 }).style["justify-content"]).toBe(
      "flex-end",
    );
    const floating = windowOf({
      type: "floating",
      gravity: "bottomEnd",
      offset: { x: -8, y: -16 },
    });
    expect(floating.style).toMatchObject({ "align-items": "end", "justify-items": "end" });
    expect((floating.children[0] as { style: Record<string, string> }).style.transform).toBe(
      "translate(-8px, -16px)",
    );
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
