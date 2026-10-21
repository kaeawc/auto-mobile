import { describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { hasPrototypeAnchors } from "../../../src/features/prototype/prototypeAnchors";
import { prototypeDataModelFields } from "../../../src/features/prototype/prototypeData";
import { prototypeThemeModeFields } from "../../../src/features/prototype/prototypeThemeModes";
import { applyPrototypePatch } from "../../../src/features/prototype/prototypePatch";

const text = { type: "text", text: "Screen" };
const stack = { type: "stack", id: "nav", start: "home", screens: { home: text } };
const spec = (root: unknown) => ({
  id: "panel",
  window: { placement: { type: "fullscreen" } },
  root,
});

describe("prototype stack validation", () => {
  test.each([0, 33])("refuses %s screens in both schemas", (count) => {
    const value = spec({
      ...stack,
      screens: Object.fromEntries(Array.from({ length: count }, (_, i) => [String(i), text])),
    });
    expect(validatePrototypeSpec(value)).toMatchObject({
      success: false,
      error: { path: "root.screens" },
    });
    expect(prototypeSpecSchema.safeParse(value).success).toBe(false);
  });
  test("accepts 32 screens and arbitrary nonempty names", () => {
    const screens = Object.fromEntries(Array.from({ length: 32 }, (_, i) => [`screen ${i}`, text]));
    const value = spec({ ...stack, start: "screen 0", screens });
    expect(validatePrototypeSpec(value).success).toBe(true);
    expect(prototypeSpecSchema.safeParse(value).success).toBe(true);
  });
  test("accepts common layout fields", () => {
    const value = {
      ...spec({
        ...stack,
        style: { width: { dp: 320 }, height: { dp: 480 } },
        visibleWhen: { key: "open", equals: true },
        transition: "fade",
      }),
      state: { open: true },
    };
    expect(validatePrototypeSpec(value).success).toBe(true);
    expect(prototypeSpecSchema.safeParse(value).success).toBe(true);
  });
  test("rejects empty names and unknown fields", () => {
    for (const root of [
      { ...stack, screens: { "": text } },
      { ...stack, unknownField: true },
    ]) {
      expect(validatePrototypeSpec(spec(root)).success).toBe(false);
      expect(prototypeSpecSchema.safeParse(spec(root)).success).toBe(false);
    }
  });
  test("counts hidden screens toward depth", () => {
    let hidden: unknown = text;
    for (let i = 0; i < contract.limits.MAX_PROTOTYPE_DEPTH; i++) {
      hidden = { type: "column", children: [hidden] };
    }
    expect(
      validatePrototypeSpec(spec({ ...stack, screens: { home: text, hidden } })),
    ).toMatchObject({ success: false, error: { message: "Tree depth limit exceeded" } });
  });
  test("counts hidden screens toward node budget", () => {
    const hidden = {
      type: "column",
      repeat: { as: "item", items: Array.from({ length: 128 }, () => ({ label: "x" })) },
      children: Array.from({ length: 16 }, () => text),
    };
    expect(
      validatePrototypeSpec(spec({ ...stack, screens: { home: text, hidden } })),
    ).toMatchObject({ success: false, error: { message: expect.stringContaining("node limit") } });
  });
  test("refuses stack inside a repeat template", () => {
    expect(
      validatePrototypeSpec(
        spec({
          type: "column",
          repeat: { as: "item", items: [{ label: "x" }] },
          children: [stack],
        }),
      ),
    ).toMatchObject({
      success: false,
      error: { path: "root.children[0]", message: "Stack cannot appear inside a repeat template" },
    });
  });
  test("expands component props and finds repeat anchors in hidden screens", () => {
    const value = {
      ...spec({
        ...stack,
        screens: {
          home: text,
          hidden: { type: "use", component: "card", props: { label: "Bound" } },
        },
      }),
      components: {
        card: {
          root: {
            type: "column",
            repeat: { as: "item", items: [{ label: "One" }] },
            children: [
              {
                type: "text",
                text: "{props.label}",
                anchor: { type: "bounds", bounds: { x: 0, y: 0, width: 10, height: 10 } },
              },
            ],
          },
        },
      },
    };
    const parsed = validatePrototypeSpec(value);
    expect(parsed.success).toBe(true);
    if (!parsed.success) {
      return;
    }
    expect(hasPrototypeAnchors(parsed.data)).toBe(true);
    expect(parsed.data.root).toMatchObject({
      screens: { hidden: { children: [{ text: "Bound" }] } },
    });
  });
  test("finds hidden data and theme bindings and patch targets", () => {
    const value = spec({
      ...stack,
      screens: {
        home: text,
        hidden: {
          type: "text",
          id: "target",
          text: "{data:/title}",
          style: { color: { light: "primary", dark: "onSurface" } },
        },
      },
    });
    expect(prototypeDataModelFields(value)).toContain('root.screens["hidden"].text');
    expect(prototypeThemeModeFields(value)).toContain('root.screens["hidden"].style.color');
    expect(
      applyPrototypePatch(value, [
        { op: "replaceNode", id: "target", node: { ...text, id: "target", text: "Updated" } },
      ]),
    ).toMatchObject({
      success: true,
      spec: { root: { screens: { hidden: { text: "Updated" } } } },
    });
  });
});

test("special screen names survive decoding and hidden scroll defaults apply", () => {
  const screens = JSON.parse(
    '{"__proto__":{"type":"scroll","child":{"type":"text","text":"Home"}}}',
  );
  const value = spec({ ...stack, start: "__proto__", screens });
  const result = validatePrototypeSpec(value);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(result.data.root).toMatchObject({ screens: { ["__proto__"]: { axis: "vertical" } } });
  }
});
