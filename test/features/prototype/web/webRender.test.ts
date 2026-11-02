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
    expect(textOf(bar)).toBe("Inbox");
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
