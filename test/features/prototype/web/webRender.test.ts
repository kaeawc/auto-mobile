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
/** Text outside icon placeholders, whose initials are drawing rather than label. */
const labelOf = (node: WebChild): string =>
  typeof node === "string" || node.attrs.role !== "img" ? labelText(node) : "";
const labelText = (node: WebChild): string =>
  typeof node === "string" ? node : node.children.map(labelOf).join("");
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

  test("an unsized fullscreen or sheet root fills its window; a floating root does not", () => {
    const rootOf = (placement: Record<string, unknown>, style?: Record<string, unknown>) =>
      byTag(
        renderPrototypeStill({
          ...reference,
          window: { placement },
          root: { type: "column", testTag: "root", children: [], ...(style ? { style } : {}) },
        }),
        "root",
      )[0]!.style;
    expect(rootOf({ type: "fullscreen" })).toMatchObject({ flex: "1 1 auto", width: "100%" });
    expect(rootOf({ type: "sheet", edge: "bottom", height: 200 })).toMatchObject({
      flex: "1 1 auto",
    });
    expect(rootOf({ type: "fullscreen" }, { height: { dp: 40 } })).toMatchObject({
      height: "40px",
    });
    expect(rootOf({ type: "floating", gravity: "center" })).not.toHaveProperty("flex");
  });

  test("applies matching styleWhen entries in order and skips undecidable ones", () => {
    const spec = {
      ...reference,
      state: { picked: true },
      root: {
        type: "text",
        testTag: "styled",
        text: "x",
        style: { color: "#FF0000" },
        styleWhen: [
          { when: { key: "picked", equals: true }, style: { color: "#00FF00" } },
          { when: { data: "/feed", empty: true }, style: { color: "#0000FF" } },
        ],
      },
    };
    expect(byTag(renderPrototypeStill(spec), "styled")[0]!.style.color).toBe("rgba(0,255,0,1)");
  });

  test("draws a list item's trailing control from spec state", () => {
    const spec = {
      ...reference,
      state: { notify: true },
      root: {
        type: "listItem",
        testTag: "row",
        headline: "Notifications",
        trailing: { type: "switch", stateKey: "notify" },
      },
    };
    const row = byTag(renderPrototypeStill(spec), "row")[0]!;
    expect(find(row, (element) => element.attrs.role === "switch")[0]!.attrs["aria-checked"]).toBe(
      "true",
    );
  });

  test("resolves a typography role before explicit text overrides", () => {
    const styleOf = (style: Record<string, unknown>) =>
      byTag(
        renderPrototypeStill({
          ...reference,
          root: { type: "text", testTag: "t", text: "x", style },
        }),
        "t",
      )[0]!.style;
    expect(styleOf({ textStyle: "headlineLarge" })).toMatchObject({
      "font-size": "32px",
      "line-height": "40px",
    });
    expect(styleOf({ textStyle: "headlineLarge", textSize: 18 })).toMatchObject({
      "font-size": "18px",
    });
  });

  test("reads top-level derived values only through the derived: namespace", () => {
    const text = (value: string) =>
      textOf(
        byTag(
          renderPrototypeStill({ ...reference, root: { type: "text", testTag: "t", text: value } }),
          "t",
        )[0]!,
      );
    expect(text("{derived:totalText}")).toBe("$42.50");
    expect(text("{totalText}")).toBe("{totalText}");
  });

  test("binds data-pointer placeholders in text", () => {
    const spec = {
      ...reference,
      data: { profile: { name: "Ada" } },
      root: { type: "text", testTag: "hi", text: "Welcome {data:/profile/name}{data:/missing}" },
    };
    expect(textOf(byTag(renderPrototypeStill(spec), "hi")[0]!)).toBe("Welcome Ada");
  });

  test("adds the frame's safe area to the edges safeAreaPadding names", () => {
    const spec = {
      ...reference,
      root: {
        type: "column",
        testTag: "padded",
        children: [],
        style: { padding: { bottom: 8 } },
        safeAreaPadding: { edges: ["top", "bottom"], types: ["systemBars"] },
      },
    };
    expect(byTag(renderPrototypeStill(spec), "padded")[0]!.style).toMatchObject({
      "padding-top": "calc(0px + var(--safe-top))",
      "padding-bottom": "calc(8px + var(--safe-bottom))",
    });
    const ime = {
      ...spec,
      root: { ...spec.root, safeAreaPadding: { edges: ["bottom"], types: ["ime"] } },
    };
    expect(byTag(renderPrototypeStill(ime), "padded")[0]!.style["padding-bottom"]).toBe("8px");
  });

  test("draws a button disabled only when its enabledWhen is decidably false", () => {
    const buttonOf = (enabledWhen?: unknown) =>
      byTag(
        renderPrototypeStill({
          ...reference,
          state: { ready: false },
          root: {
            type: "button",
            testTag: "go",
            label: "Go",
            ...(enabledWhen ? { enabledWhen } : {}),
          },
        }),
        "go",
      )[0]!;
    const off = buttonOf({ key: "ready", equals: true });
    expect(off.attrs["aria-disabled"]).toBe("true");
    expect(off.style.opacity).toBe("0.38");
    expect(buttonOf().attrs["aria-disabled"]).toBeUndefined();
    expect(buttonOf({ key: "ready", equals: false }).style.opacity).toBeUndefined();
    expect(buttonOf({ data: "/feed", empty: true }).attrs["aria-disabled"]).toBeUndefined();
  });

  test("a top app bar takes the safe area only from authored safeAreaPadding", () => {
    const barOf = (extra: Record<string, unknown>) =>
      byTag(
        renderPrototypeStill({
          ...reference,
          root: { type: "topAppBar", testTag: "bar", title: "T", ...extra },
        }),
        "bar",
      )[0]!.style;
    expect(JSON.stringify(barOf({}))).not.toContain("--safe-top");
    expect(
      barOf({ safeAreaPadding: { edges: ["top"], types: ["systemBars"] } })["padding-top"],
    ).toBe("calc(0px + var(--safe-top))");
  });

  test("a top app bar draws its navigation icon and actions around the title", () => {
    const bar = byTag(
      renderPrototypeStill({
        ...reference,
        root: {
          type: "topAppBar",
          testTag: "bar",
          title: "Inbox",
          navigationIcon: { icon: "arrow_back", label: "Back" },
          actions: [{ icon: "search", label: "Search" }],
        },
      }),
      "bar",
    )[0]!;
    const slots = find(bar, (element) => element.attrs["aria-label"] !== undefined);
    expect(slots.map((element) => element.attrs["aria-label"])).toEqual(["Back", "Search"]);
    expect(
      find(bar, (element) => element.attrs.title !== undefined).map((e) => e.attrs.title),
    ).toEqual(["arrow_back", "search"]);
    expect(labelOf(bar)).toBe("Inbox");
  });

  test("a text field shows its error text only when errorWhen decidably holds", () => {
    const fieldOf = (failed: boolean, extra: Record<string, unknown> = {}) =>
      renderPrototypeStill({
        ...reference,
        state: { failed, email: "a@b" },
        root: {
          type: "textField",
          testTag: "email",
          stateKey: "email",
          supportingText: "We never share it",
          errorText: "Server error",
          errorWhen: { key: "failed", equals: true },
          ...extra,
        },
      }).element;
    const alerts = (root: WebElement) => find(root, (element) => element.attrs.role === "alert");
    expect(alerts(fieldOf(true)).map(textOf)).toEqual(["Server error"]);
    expect(alerts(fieldOf(false))).toEqual([]);
    expect(textOf(fieldOf(false))).toContain("We never share it");
    expect(alerts(fieldOf(true, { errorWhen: { data: "/x", empty: true } }))).toEqual([]);
  });

  test("an unsized spacer fills its line, and the line grows to hold it", () => {
    const spec = {
      ...reference,
      root: {
        type: "column",
        children: [
          {
            type: "row",
            testTag: "skeleton",
            style: { height: { dp: 16 }, background: "#CCCCCC" },
            children: [{ type: "spacer", testTag: "gap" }],
          },
          { type: "spacer", testTag: "sized", style: { height: { dp: 8 } } },
        ],
      },
    };
    const still = renderPrototypeStill(spec);
    expect(byTag(still, "skeleton")[0]!.style).toMatchObject({ width: "100%", height: "16px" });
    expect(byTag(still, "gap")[0]!.style).toMatchObject({ flex: "1 1 auto" });
    expect(byTag(still, "sized")[0]!.style).not.toHaveProperty("flex");
  });

  test("a wrap-sized line with a weighted child grows on its main axis (#16682)", () => {
    const styleOf = (root: Record<string, unknown>, tag: string) =>
      byTag(renderPrototypeStill({ ...reference, root }), tag)[0]!.style;
    const weighted = (style: Record<string, unknown>) => ({
      type: "box",
      testTag: "w",
      style,
    });
    const rowWith = (child: Record<string, unknown>, style: Record<string, unknown> = {}) => ({
      type: "column",
      children: [
        { type: "row", testTag: "r", style, children: [{ type: "text", text: "abc" }, child] },
      ],
    });
    const box = weighted({ weight: 1, height: { dp: 10 } });
    expect(styleOf(rowWith(box), "r")).toMatchObject({ width: "100%" });
    expect(styleOf(rowWith(box), "w")).toMatchObject({ flex: "1 1 0" });
    // No weight, a zero weight, or an authored width keeps the row at its own size.
    expect(styleOf(rowWith(weighted({ height: { dp: 10 } })), "r")).not.toHaveProperty("width");
    expect(styleOf(rowWith(weighted({ weight: 0 })), "r")).not.toHaveProperty("width");
    expect(styleOf(rowWith(box, { width: { dp: 120 } }), "r")).toMatchObject({ width: "120px" });
    // A column grows on its height, inside a row, and only on that axis.
    const column = styleOf(
      {
        type: "row",
        children: [{ type: "column", testTag: "c", children: [weighted({ weight: 2 })] }],
      },
      "c",
    );
    expect(column).toMatchObject({ height: "100%" });
    expect(column).not.toHaveProperty("width");
  });

  test("a hidden weighted child does not grow its line (#16682)", () => {
    const rowOf = (show: boolean) =>
      byTag(
        renderPrototypeStill({
          ...reference,
          state: { show },
          root: {
            type: "column",
            children: [
              {
                type: "row",
                testTag: "r",
                children: [
                  {
                    type: "box",
                    style: { weight: 1 },
                    visibleWhen: { key: "show", equals: true },
                  },
                ],
              },
            ],
          },
        }),
        "r",
      )[0]!.style;
    expect(rowOf(true)).toMatchObject({ width: "100%" });
    expect(rowOf(false)).not.toHaveProperty("width");
  });

  test("a box does not grow around a weighted child (#16682)", () => {
    const style = byTag(
      renderPrototypeStill({
        ...reference,
        root: {
          type: "column",
          children: [
            { type: "box", testTag: "b", children: [{ type: "box", style: { weight: 1 } }] },
          ],
        },
      }),
      "b",
    )[0]!.style;
    expect(style).not.toHaveProperty("width");
    expect(style).not.toHaveProperty("flex");
  });

  test("draws list-item and text-field icon slots", () => {
    const iconsOf = (root: Record<string, unknown>) =>
      find(
        renderPrototypeStill({ ...reference, root }).element,
        (element) => element.attrs.role === "img",
      ).map((element) => element.attrs.title);
    expect(iconsOf({ type: "listItem", headline: "Wifi", leadingIcon: "wifi" })).toEqual(["wifi"]);
    expect(
      iconsOf({
        type: "textField",
        stateKey: "q",
        leadingIcon: "search",
        trailingIcon: { icon: "close", label: "Clear" },
      }),
    ).toEqual(["search", "close"]);
  });

  test("resolves string-table translations before binding text", () => {
    const spec = JSON.parse(
      readFileSync(
        join(import.meta.dir, "../../../fixtures/prototype-spec/valid/strings-and-semantics.json"),
        "utf8",
      ),
    ) as Record<string, unknown>;
    const html = toHtml(renderPrototypeStill(spec).element);
    expect(html).not.toContain("{t:");
    expect(html).toContain("2 items");
  });

  test("binds repeated text once, and binds list-item text inside a repeat", () => {
    const spec = {
      ...reference,
      root: {
        type: "column",
        repeat: { as: "item", items: [{ name: "{item.other}", other: "Ada" }] },
        children: [
          { type: "text", testTag: "once", text: "{item.name}" },
          { type: "listItem", testTag: "row", headline: "{item.other}" },
        ],
      },
    };
    const still = renderPrototypeStill(spec);
    expect(textOf(byTag(still, "once")[0]!)).toBe("{item.other}");
    expect(textOf(byTag(still, "row")[0]!)).toBe("Ada");
  });

  test("a captioned text field's wrapper takes its sizing in the parent", () => {
    const row = byTag(
      renderPrototypeStill({
        ...reference,
        root: {
          type: "row",
          testTag: "line",
          children: [
            {
              type: "textField",
              testTag: "field",
              stateKey: "q",
              supportingText: "Hint",
              style: { width: "fill", weight: 1 },
            },
          ],
        },
      }),
      "line",
    )[0]!;
    const wrapper = row.children[0] as WebElement;
    expect(wrapper.style).toMatchObject({ flex: "1 1 0", "flex-direction": "column" });
    expect(byTag({ element: row }, "field")[0]!.style).not.toHaveProperty("flex");
  });

  test("an explicit wrap-width root keeps its content width in its window", () => {
    const layerOf = (placement: Record<string, unknown>) =>
      find(
        renderPrototypeStill({
          ...reference,
          window: { placement },
          root: { type: "column", testTag: "root", children: [], style: { width: "wrap" } },
        }).element,
        (element) => element.attrs["data-window"] !== undefined,
      )[0]!;
    expect(layerOf({ type: "fullscreen" }).style["align-items"]).toBe("flex-start");
    const sheet = layerOf({ type: "sheet", edge: "bottom", height: 200 });
    expect((sheet.children[0] as WebElement).style["align-items"]).toBe("flex-start");
  });

  test("draws switches, checkboxes, text fields and list items disabled when enabledWhen is false", () => {
    const disabledOf = (type: string) =>
      byTag(
        renderPrototypeStill({
          ...reference,
          state: { ready: false, on: true },
          root: {
            type,
            testTag: "c",
            stateKey: "on",
            label: "L",
            headline: "H",
            enabledWhen: { key: "ready", equals: true },
          },
        }),
        "c",
      )[0]!;
    for (const type of ["switch", "checkbox", "textField", "listItem"]) {
      expect(disabledOf(type).attrs["aria-disabled"]).toBe("true");
      expect(disabledOf(type).style.opacity).toBe("0.38");
    }
  });

  test("draws a button's icon before its label", () => {
    const button = byTag(
      renderPrototypeStill({
        ...reference,
        root: { type: "button", testTag: "save", label: "Save", icon: "check" },
      }),
      "save",
    )[0]!;
    expect((button.children[0] as WebElement).attrs.title).toBe("check");
    expect(labelOf(button)).toBe("Save");
  });

  test("a span keeps its own text decoration", () => {
    const rich = byTag(
      renderPrototypeStill({
        ...reference,
        root: {
          type: "text",
          testTag: "price",
          spans: [{ text: "$100", style: { textDecoration: "lineThrough" } }, { text: " $80" }],
        },
      }),
      "price",
    )[0]!;
    expect(toHtml(rich)).toContain('<span style="text-decoration:line-through">$100</span>');
  });

  test("paints a divider with its authored colour", () => {
    const line = byTag(
      renderPrototypeStill({
        ...reference,
        root: { type: "divider", testTag: "d", style: { color: "#FF0000" } },
      }),
      "d",
    )[0]!;
    expect(line.style["background-color"]).toBe("rgba(255,0,0,1)");
  });

  test("a text field keeps its label above a value or placeholder", () => {
    const field = (state: Record<string, unknown>, extra: Record<string, unknown> = {}) =>
      byTag(
        renderPrototypeStill({
          ...reference,
          state,
          root: {
            type: "textField",
            testTag: "f",
            stateKey: "email",
            label: "Work email",
            ...extra,
          },
        }),
        "f",
      )[0]!;
    const labels = (element: WebElement) =>
      find(element, (child) => child.attrs["data-slot"] === "label").map(textOf);
    expect(labels(field({ email: "ada@example.com" }))).toEqual(["Work email"]);
    expect(textOf(field({ email: "ada@example.com" }))).toContain("ada@example.com");
    expect(labels(field({ email: "" }, { placeholder: "you@work" }))).toEqual(["Work email"]);
    expect(labels(field({ email: "" }))).toEqual([]);
    expect(textOf(field({ email: "" }))).toBe("Work email");
  });

  test("a sheet spans the screen width", () => {
    const layer = find(
      renderPrototypeStill({
        ...reference,
        window: { placement: { type: "sheet", edge: "bottom", height: 200 } },
      }).element,
      (element) => element.attrs["data-window"] === "sheet",
    )[0]!;
    expect((layer.children[0] as WebElement).style["align-self"]).toBe("stretch");
  });

  test("a multiline text field keeps newlines and its line bounds", () => {
    const value = (multiline: boolean) =>
      find(
        renderPrototypeStill({
          ...reference,
          state: { note: "First line\nSecond line" },
          root: { type: "textField", stateKey: "note", multiline, minLines: 2, maxLines: 4 },
        }).element,
        (element) => element.children.includes("First line\nSecond line"),
      )[0]!.style;
    expect(value(true)).toMatchObject({
      "white-space": "pre-wrap",
      "min-height": "48px",
      "max-height": "96px",
    });
    expect(value(false)).not.toHaveProperty("white-space");
  });

  test("a card keeps wrap-sized children at their own width", () => {
    const card = byTag(
      renderPrototypeStill({
        ...reference,
        root: { type: "card", testTag: "card", children: [{ type: "button", label: "Go" }] },
      }),
      "card",
    )[0]!;
    expect(card.style["align-items"]).toBe("flex-start");
  });

  test("an icon placeholder lays out at its size, even inside an action slot", () => {
    const bar = byTag(
      renderPrototypeStill({
        ...reference,
        root: {
          type: "topAppBar",
          testTag: "bar",
          title: "T",
          actions: [{ icon: "search", label: "Search" }],
        },
      }),
      "bar",
    )[0]!;
    const glyph = find(bar, (element) => element.attrs.title === "search")[0]!;
    expect(glyph.style).toMatchObject({ display: "inline-flex", width: "24px" });
  });

  test("a top app bar honours its variant's size and title alignment", () => {
    const barOf = (variant: string) =>
      byTag(
        renderPrototypeStill({
          ...reference,
          root: { type: "topAppBar", testTag: "bar", title: "T", variant },
        }),
        "bar",
      )[0]!;
    expect(barOf("large").style["min-height"]).toBe("152px");
    expect(barOf("medium").style["font-size"]).toBe("28px");
    expect((barOf("centerAligned").children[0] as WebElement).style["text-align"]).toBe("center");
    expect(barOf("small").style["min-height"]).toBe("64px");
  });

  test("a hidden spacer does not make its line fill", () => {
    const rowOf = (show: boolean) =>
      byTag(
        renderPrototypeStill({
          ...reference,
          state: { show },
          root: {
            type: "column",
            children: [
              {
                type: "row",
                testTag: "r",
                children: [{ type: "spacer", visibleWhen: { key: "show", equals: true } }],
              },
            ],
          },
        }),
        "r",
      )[0]!.style;
    expect(rowOf(true)).toMatchObject({ flex: "1 1 auto" });
    expect(rowOf(false)).not.toHaveProperty("flex");
  });

  test("a descendant asking for an inset an ancestor applied adds nothing more", () => {
    const safe = { edges: ["top"], types: ["systemBars"] };
    const still = renderPrototypeStill({
      ...reference,
      root: {
        type: "column",
        testTag: "outer",
        safeAreaPadding: safe,
        children: [
          { type: "column", testTag: "inner", safeAreaPadding: safe, children: [] },
          {
            type: "column",
            testTag: "bottom",
            safeAreaPadding: { edges: ["bottom"], types: ["systemBars"] },
            children: [],
          },
        ],
      },
    });
    expect(byTag(still, "outer")[0]!.style["padding-top"]).toBe("calc(0px + var(--safe-top))");
    expect(byTag(still, "inner")[0]!.style).not.toHaveProperty("padding-top");
    expect(byTag(still, "bottom")[0]!.style["padding-bottom"]).toBe(
      "calc(0px + var(--safe-bottom))",
    );
  });

  test("semantics.label wins over contentDescription for the accessible label", () => {
    const labelOf = (extra: Record<string, unknown>) =>
      byTag(
        renderPrototypeStill({
          ...reference,
          root: { type: "text", testTag: "t", text: "$5", ...extra },
        }),
        "t",
      )[0]!.attrs["aria-label"];
    expect(
      labelOf({ semantics: { label: "Price five dollars" }, contentDescription: "Old label" }),
    ).toBe("Price five dollars");
    expect(labelOf({ contentDescription: "Old label" })).toBe("Old label");
  });

  test("a repeat skips scalar items before assigning indices, as on devices", () => {
    const spec = {
      ...reference,
      data: { items: [12, true, { title: "Ada" }] },
      root: {
        type: "column",
        testTag: "list",
        repeat: { as: "item", items: { path: "/items" } },
        children: [{ type: "text", text: "{index}: {item.title}" }],
      },
    };
    expect(textOf(byTag(renderPrototypeStill(spec), "list")[0]!)).toBe("0: Ada");
  });

  test("a span keeps its own background", () => {
    const rich = byTag(
      renderPrototypeStill({
        ...reference,
        root: {
          type: "text",
          testTag: "w",
          spans: [{ text: "Warning", style: { background: "#FF0000" } }],
        },
      }),
      "w",
    )[0]!;
    expect(toHtml(rich)).toContain("background-color:rgba(255,0,0,1)");
  });

  test("a text field draws filled chrome by default and an outline when outlined", () => {
    const fieldOf = (variant?: string) =>
      byTag(
        renderPrototypeStill({
          ...reference,
          root: { type: "textField", testTag: "f", stateKey: "q", ...(variant ? { variant } : {}) },
        }),
        "f",
      )[0]!.style;
    expect(fieldOf()).toHaveProperty("border-bottom");
    expect(fieldOf()).toHaveProperty("background-color");
    expect(fieldOf()).not.toHaveProperty("border");
    expect(fieldOf("outlined")).toHaveProperty("border");
    expect(fieldOf("outlined")).not.toHaveProperty("background-color");
  });

  test("a scroll start-aligns wrap-sized content", () => {
    const scroll = byTag(
      renderPrototypeStill({
        ...reference,
        root: {
          type: "scroll",
          testTag: "s",
          child: {
            type: "column",
            style: { width: "wrap" },
            children: [{ type: "text", text: "Hi" }],
          },
        },
      }),
      "s",
    )[0]!;
    expect(scroll.style["align-items"]).toBe("flex-start");
  });

  test("an expanded app bar keeps its actions at the trailing edge", () => {
    const bar = byTag(
      renderPrototypeStill({
        ...reference,
        root: {
          type: "topAppBar",
          testTag: "bar",
          title: "Inbox",
          variant: "large",
          navigationIcon: { icon: "arrow_back", label: "Back" },
          actions: [{ icon: "search", label: "Search" }],
        },
      }),
      "bar",
    )[0]!;
    const labels = bar.children.map((item) =>
      typeof item === "string" ? item : (item.attrs["aria-label"] ?? item.style.flex ?? ""),
    );
    expect(labels).toEqual(["Back", "", "1 1 auto", "Search"]);
  });

  test("the window takes the spec's explicit layout direction; the frame does not", () => {
    const still = renderPrototypeStill({ ...reference, window: { layoutDirection: "rtl" } });
    const layer = find(still.element, (element) => element.attrs["data-window"] !== undefined)[0]!;
    expect(layer.attrs.dir).toBe("rtl");
    // In RTL the logical start inset is the physical right one.
    expect(layer.style["--safe-start"]).toBe("var(--safe-right)");
    expect(layer.style["--safe-end"]).toBe("var(--safe-left)");
    expect(still.element.attrs).not.toHaveProperty("dir");
  });

  test("a safe-area inset adds to a control's own padding on that edge", () => {
    const button = byTag(
      renderPrototypeStill({
        ...reference,
        root: {
          type: "button",
          testTag: "b",
          label: "Go",
          safeAreaPadding: { edges: ["start"], types: ["systemBars"] },
        },
      }),
      "b",
    )[0]!;
    expect(button.style).toMatchObject({
      "padding-inline-start": "calc(24px + var(--safe-start))",
      "padding-inline-end": "24px",
    });
    expect(button.style).not.toHaveProperty("padding");
  });

  test("theme typography scales and sets the family of every type-scale role", () => {
    const text = byTag(
      renderPrototypeStill({
        ...reference,
        theme: { ...(reference.theme as object), typography: { scale: 1.25, fontFamily: "serif" } },
        root: { type: "text", testTag: "t", text: "x", style: { textStyle: "headlineLarge" } },
      }),
      "t",
    )[0]!;
    expect(text.style).toMatchObject({
      "font-size": "40px",
      "line-height": "50px",
      "font-family": "serif",
    });
  });

  test("a horizontal divider stretches across a box", () => {
    const line = byTag(
      renderPrototypeStill({
        ...reference,
        root: {
          type: "box",
          style: { width: { dp: 200 }, height: { dp: 200 } },
          children: [{ type: "divider", testTag: "d" }],
        },
      }),
      "d",
    )[0]!;
    expect(line.style["justify-self"]).toBe("stretch");
  });

  test("a reverse scroll starts at its end", () => {
    const scrollOf = (reverse: boolean) =>
      byTag(
        renderPrototypeStill({
          ...reference,
          root: { type: "scroll", testTag: "s", reverse, child: { type: "column", children: [] } },
        }),
        "s",
      )[0]!.style["flex-direction"];
    expect(scrollOf(true)).toBe("column-reverse");
    expect(scrollOf(false)).toBe("column");
  });

  test("a spacer sized by a matching styleWhen does not make its line fill", () => {
    const row = byTag(
      renderPrototypeStill({
        ...reference,
        state: { compact: true },
        root: {
          type: "column",
          children: [
            {
              type: "row",
              testTag: "r",
              children: [
                {
                  type: "spacer",
                  styleWhen: [
                    {
                      when: { key: "compact", equals: true },
                      style: { width: { dp: 8 }, height: { dp: 8 } },
                    },
                  ],
                },
              ],
            },
          ],
        },
      }),
      "r",
    )[0]!;
    expect(row.style).not.toHaveProperty("flex");
  });

  test("inserted data and repeat values are never read again as state placeholders", () => {
    const spec = {
      ...reference,
      state: { secret: "LEAK" },
      data: { note: "{secret}" },
      root: {
        type: "column",
        repeat: { as: "item", items: [{ label: "{secret}" }] },
        children: [
          { type: "text", testTag: "d", text: "{data:/note}" },
          { type: "text", testTag: "r", text: "{item.label}" },
        ],
      },
    };
    const still = renderPrototypeStill(spec);
    expect(textOf(byTag(still, "d")[0]!)).toBe("{secret}");
    expect(textOf(byTag(still, "r")[0]!)).toBe("{secret}");
  });

  test("a repeated line with no rows stays wrap-sized", () => {
    const row = byTag(
      renderPrototypeStill({
        ...reference,
        data: { rows: [] },
        root: {
          type: "column",
          children: [
            {
              type: "row",
              testTag: "r",
              repeat: { as: "item", items: { path: "/rows" } },
              children: [{ type: "spacer" }],
            },
          ],
        },
      }),
      "r",
    )[0]!;
    expect(row.style).not.toHaveProperty("flex");
  });

  test("a center-aligned title is centred on the bar, not beside the navigation slot", () => {
    const bar = byTag(
      renderPrototypeStill({
        ...reference,
        root: {
          type: "topAppBar",
          testTag: "bar",
          title: "T",
          variant: "centerAligned",
          navigationIcon: { icon: "arrow_back", label: "Back" },
        },
      }),
      "bar",
    )[0]!;
    const title = bar.children.find(
      (child) => typeof child !== "string" && textOf(child) === "T",
    ) as WebElement;
    expect(title.style).toMatchObject({ position: "absolute", left: "0", right: "0" });
    expect(bar.style.position).toBe("relative");
  });

  test("a captioned field's wrapper takes its max width; a disabled list item disables its trailing control", () => {
    const field = byTag(
      renderPrototypeStill({
        ...reference,
        root: {
          type: "column",
          testTag: "c",
          children: [
            {
              type: "textField",
              stateKey: "q",
              supportingText: "Hint",
              style: { maxWidth: 200 },
            },
          ],
        },
      }),
      "c",
    )[0]!;
    const wrapper = field.children[0] as WebElement;
    expect(wrapper.style["max-width"]).toBe("200px");
    expect((wrapper.children[0] as WebElement).style).not.toHaveProperty("max-width");
    const row = byTag(
      renderPrototypeStill({
        ...reference,
        state: { ready: false, on: true },
        root: {
          type: "listItem",
          testTag: "li",
          headline: "H",
          enabledWhen: { key: "ready", equals: true },
          trailing: { type: "switch", stateKey: "on" },
        },
      }),
      "li",
    )[0]!;
    const toggle = find(row, (element) => element.attrs.role === "switch")[0]!;
    expect(toggle.attrs["aria-disabled"]).toBe("true");
  });

  test("text keeps private-use characters exactly, authored or inserted", () => {
    const spec = {
      ...reference,
      state: { mark: "\uE000o\uE001" },
      data: { note: "\uE000c" },
      root: { type: "text", testTag: "t", text: "\uE000o\uE000e\uE001 {mark} {data:/note}" },
    };
    expect(textOf(byTag(renderPrototypeStill(spec), "t")[0]!)).toBe(
      "\uE000o\uE000e\uE001 \uE000o\uE001 \uE000c",
    );
  });

  test("placeholder keys with private-use characters still bind their own values", () => {
    const spec = {
      ...reference,
      state: { "s\uE000": "S", "s\uE000e": "wrong" },
      data: { "d\uE000": "D", "d\uE000e": "wrong" },
      root: { type: "text", testTag: "t", text: "{s\uE000} {data:/d\uE000}" },
    };
    expect(textOf(byTag(renderPrototypeStill(spec), "t")[0]!)).toBe("S D");
  });

  test("per-corner radii replace a control's default radius instead of being reset by it", () => {
    const icon = byTag(
      renderPrototypeStill({
        ...reference,
        root: {
          type: "icon",
          testTag: "i",
          name: "star",
          style: { cornerRadius: { bottomStart: 30, bottomEnd: 40 } },
        },
      }),
      "i",
    )[0]!;
    expect(icon.style).not.toHaveProperty("border-radius");
    expect(icon.style).toMatchObject({
      "border-end-start-radius": "30px",
      "border-end-end-radius": "40px",
    });
  });

  test("an explicit theme mode wins over the caller's; system falls back to it", () => {
    const surface = (mode: string | undefined, option?: "light" | "dark") =>
      byTag(
        renderPrototypeStill(
          {
            ...reference,
            theme: { ...(reference.theme as object), ...(mode ? { mode } : {}) },
            root: { type: "column", testTag: "bg", children: [], style: { background: "surface" } },
          },
          option ? { mode: option } : {},
        ),
        "bg",
      )[0]!.style["background-color"];
    const light = surface(undefined, "light");
    const dark = surface(undefined, "dark");
    expect(light).not.toBe(dark);
    expect(surface("dark")).toBe(dark);
    expect(surface("light", "dark")).toBe(light);
    expect(surface("system", "dark")).toBe(dark);
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

describe("prototype web still parity (#16382)", () => {
  const screenOf = (spec: Record<string, unknown>, options: { mode?: "light" | "dark" } = {}) =>
    find(
      renderPrototypeStill(spec, options).element,
      (element) => element.attrs["data-chrome"] === "screen",
    )[0]!;
  const bare = { id: "bare", root: { type: "column", children: [] } };

  test("the screen paints the theme background, not a checkerboard", () => {
    const screen = screenOf({ ...bare, theme: { colors: { background: "#123456" } } });
    expect(screen.style["background-color"]).toBe("rgba(18,52,86,1)");
    expect(toHtml(screen)).not.toContain("conic-gradient");
  });

  test("a seed or device scheme paints the Material 3 baseline background for the mode", () => {
    const seeded = { ...bare, theme: { colors: { seed: "#336699" } } };
    expect(screenOf(seeded).style["background-color"]).toBe("rgba(254,247,255,1)");
    expect(screenOf(seeded, { mode: "dark" }).style["background-color"]).toBe("rgba(20,18,24,1)");
    const device = { ...bare, theme: { colors: { source: "device" } } };
    expect(screenOf(device).style["background-color"]).toBe("rgba(254,247,255,1)");
  });

  test("a top app bar without safeAreaPadding takes no status-bar inset, as on the devices", () => {
    const bar = byTag(
      renderPrototypeStill({ ...bare, root: { type: "topAppBar", testTag: "bar", title: "T" } }),
      "bar",
    )[0]!;
    expect(JSON.stringify(bar.style)).not.toContain("--safe-top");
  });

  test("a card hugs its content unless its width is fill, as on the devices", () => {
    const cardOf = (style?: Record<string, unknown>) =>
      byTag(
        renderPrototypeStill({
          ...bare,
          root: {
            type: "column",
            children: [
              { type: "card", testTag: "card", ...(style ? { style } : {}), children: [] },
            ],
          },
        }),
        "card",
      )[0]!;
    expect(cardOf().style).not.toHaveProperty("align-self");
    expect(cardOf().style).not.toHaveProperty("width");
    expect(cardOf({ width: "fill" }).style).toMatchObject({ "align-self": "stretch" });
  });

  const toggleOf = (type: string, on: boolean) =>
    byTag(
      renderPrototypeStill({
        ...bare,
        state: { on },
        root: { type, testTag: "t", stateKey: "on", label: "Alarm" },
      }),
      "t",
    )[0]!;

  test("a switch draws a thumb at the end when on and at the start when off", () => {
    const thumbOf = (on: boolean) =>
      find(toggleOf("switch", on), (element) => element.attrs["data-part"] === "thumb")[0]!;
    expect(thumbOf(true).style["margin-inline-start"]).toBe("auto");
    expect(thumbOf(false).style).not.toHaveProperty("margin-inline-start");
    expect(thumbOf(true).style.width).not.toBe(thumbOf(false).style.width);
  });

  test("a switch's label precedes its track and a checkbox's box precedes its label", () => {
    expect(toggleOf("switch", true).children[0]).toBe("Alarm");
    const checkbox = toggleOf("checkbox", true);
    expect(typeof checkbox.children[0]).not.toBe("string");
    expect(checkbox.children[1]).toBe("Alarm");
  });

  test("an icon placeholder shows its name's initial", () => {
    const iconOf = (name?: string) =>
      byTag(
        renderPrototypeStill({
          ...bare,
          root: {
            type: "column",
            children: [{ type: "icon", testTag: "i", ...(name === undefined ? {} : { name }) }],
          },
        }),
        "i",
      )[0]!;
    expect(textOf(iconOf("search"))).toBe("S");
    expect(textOf(iconOf("_star"))).toBe("S");
    expect(textOf(iconOf())).toBe("");
    expect(iconOf("search").attrs.title).toBe("search");
    expect(iconOf("search").style).toMatchObject({ width: "24px", height: "24px" });
  });
});

describe("prototype web still stack screens (#16382)", () => {
  const nested = {
    id: "nested",
    root: {
      type: "stack",
      start: "home",
      screens: {
        home: {
          type: "column",
          children: [
            { type: "text", text: "Home" },
            {
              type: "stack",
              start: "inner",
              screens: {
                inner: { type: "text", text: "Inner" },
                other: { type: "text", text: "Other" },
              },
            },
          ],
        },
        pay: { type: "text", text: "Pay" },
      },
    },
  };

  test("draws the chosen screen of the outermost stack instead of its start", () => {
    const done = renderPrototypeStill(reference, { frame: "pixel-9", screen: "done" });
    expect(toHtml(done.element)).toContain("Thanks");
    expect(done.stack).toEqual({ start: "cart", screens: ["cart", "done"], screen: "done" });
  });

  test("an unknown screen draws the start screen", () => {
    const start = renderPrototypeStill(reference, { frame: "pixel-9" });
    const unknown = renderPrototypeStill(reference, { frame: "pixel-9", screen: "nope" });
    expect(toHtml(unknown.element)).toBe(toHtml(start.element));
    expect(unknown.stack).toEqual({ start: "cart", screens: ["cart", "done"], screen: "cart" });
  });

  test("a nested stack keeps drawing its own start screen", () => {
    for (const screen of ["home", "other"]) {
      const still = renderPrototypeStill(nested, { screen });
      const html = toHtml(still.element);
      expect(html).toContain("Home");
      expect(html).toContain("Inner");
      expect(html).not.toContain("Other");
      expect(still.stack).toEqual({ start: "home", screens: ["home", "pay"], screen: "home" });
    }
    expect(toHtml(renderPrototypeStill(nested, { screen: "pay" }).element)).toContain("Pay");
  });

  test("a spec without a stack reports none", () => {
    const still = renderPrototypeStill({ id: "bare", root: { type: "column", children: [] } });
    expect(still.stack).toBeUndefined();
  });
});

describe("prototype web still platform state (#16448)", () => {
  const adaptive = {
    ...reference,
    root: {
      type: "column",
      children: [
        {
          type: "text",
          testTag: "wide",
          text: "wide",
          visibleWhen: { platform: "/device/widthClass", equals: "expanded" },
        },
        {
          type: "text",
          testTag: "label",
          text: "{platform:/device/os} {platform:/device/widthClass}|{platform:/device/posture}|{platform:/device/idiom}",
        },
      ],
    },
  };

  test("a widthClass condition resolves per frame and orientation", () => {
    expect(byTag(renderPrototypeStill(adaptive, { frame: "pixel-9" }), "wide")).toHaveLength(0);
    expect(
      byTag(renderPrototypeStill(adaptive, { frame: "pixel-9", orientation: "landscape" }), "wide"),
    ).toHaveLength(1);
  });

  test("text binds the platform state the frame decides and leaves other pointers literal", () => {
    const label = (options: Parameters<typeof renderPrototypeStill>[1]) =>
      textOf(byTag(renderPrototypeStill(adaptive, options), "label")[0]!);
    expect(label({ frame: "medium-tablet" })).toBe("android medium||{platform:/device/idiom}");
    expect(label({ frame: "iphone-16" })).toBe("ios compact||{platform:/device/idiom}");
    expect(label({ frame: "ipad-10" })).toBe("ios regular||{platform:/device/idiom}");
  });
});
