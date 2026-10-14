import { beforeAll, expect, test } from "bun:test";
import { prototypeFlowGridFields } from "../../../src/features/prototype/prototypeFlowGrid";
import { prototypeSpecSchema } from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const spec = (root: unknown) => ({
  id: "wrap",
  window: { placement: { type: "fullscreen" } },
  root,
});
const text = { type: "text", text: "Hello" };
beforeAll(() => {
  validatePrototypeSpec(spec(text));
  for (const type of ["flow", "grid"]) {
    validatePrototypeSpec(
      spec({
        type,
        ...(type === "grid" ? { columns: 2 } : { maxLines: 1 }),
        repeat: { items: Array.from({ length: 128 }, () => ({ name: "x" })), as: "item" },
        children: Array.from({ length: 15 }, () => text),
      }),
    );
  }
});

test.each(["flow", "grid"])("%s counts every repeated child even when visually clipped", (type) => {
  const root = {
    type,
    ...(type === "grid" ? { columns: 2 } : { maxLines: 1 }),
    repeat: { items: Array.from({ length: 128 }, () => ({ name: "x" })), as: "item" },
    children: Array.from({ length: 15 }, () => text),
  };
  expect(validatePrototypeSpec(spec(root)).success).toBe(true);
  const result = validatePrototypeSpec(spec({ ...root, children: [...root.children, text] }));
  expect(result).toMatchObject({
    success: false,
    error: { message: "Expanded node limit exceeded" },
  });
});

test.each([0, 1, Number.MAX_VALUE, -1, Infinity, NaN])(
  "runSpacing bound %s mirrors spacing",
  (gap) => {
    const candidate = spec({ type: "flow", children: [], style: { runSpacing: gap } });
    expect(validatePrototypeSpec(candidate).success).toBe(Number.isFinite(gap) && gap >= 0);
    expect(prototypeSpecSchema.safeParse(candidate).success).toBe(Number.isFinite(gap) && gap >= 0);
  },
);

test.each([Number.MIN_VALUE, 1, Number.MAX_VALUE, 0, -1, Infinity, NaN])(
  "adaptive minWidth %s is finite and positive",
  (minWidth) => {
    const candidate = spec({ type: "grid", columns: { minWidth }, children: [] });
    expect(validatePrototypeSpec(candidate).success).toBe(
      Number.isFinite(minWidth) && minWidth > 0,
    );
    expect(prototypeSpecSchema.safeParse(candidate).success).toBe(
      Number.isFinite(minWidth) && minWidth > 0,
    );
  },
);

test.each([1, 12, 0, 13, 1.5])("fixed columns %s stay in 1..12", (columns) => {
  const candidate = spec({ type: "grid", columns, children: [] });
  const ok = Number.isInteger(columns) && columns >= 1 && columns <= 12;
  expect(validatePrototypeSpec(candidate).success).toBe(ok);
  expect(prototypeSpecSchema.safeParse(candidate).success).toBe(ok);
});

test("span is scoped to the immediate parent, with an adaptive runtime clamp", () => {
  expect(
    validatePrototypeSpec(
      spec({ type: "grid", columns: { minWidth: 1 }, children: [{ ...text, span: 99 }] }),
    ).success,
  ).toBe(true);
  for (const root of [
    { ...text, span: 1 },
    { type: "grid", columns: 2, children: [{ type: "column", children: [{ ...text, span: 1 }] }] },
    { type: "grid", columns: 2, children: [{ ...text, span: 3 }] },
    { type: "grid", columns: 2, children: [{ ...text, span: 0 }] },
    { type: "grid", columns: 2, children: [{ ...text, span: 1.5 }] },
  ]) {
    expect(validatePrototypeSpec(spec(root)).success).toBe(false);
  }
});

test("expanded component wrapping nodes and repeat data bindings retain their fields", () => {
  const candidate = {
    ...spec({ type: "use", component: "cards" }),
    data: { rows: [{ label: "A" }] },
    components: {
      cards: {
        root: {
          type: "grid",
          columns: 2,
          repeat: { items: { path: "/rows" }, as: "item" },
          children: [{ type: "text", text: "{item.label}", span: 2 }],
        },
      },
    },
  };
  const result = validatePrototypeSpec(candidate);
  expect(result.success).toBe(true);
  if (result.success) {
    expect(prototypeFlowGridFields(result.data)).toEqual(["root"]);
  }
});

test("capability detection walks children and child in document order", () => {
  expect(
    prototypeFlowGridFields(
      spec({
        type: "scroll",
        child: { type: "flow", children: [{ type: "grid", columns: 1, children: [] }] },
      }),
    ),
  ).toEqual(["root.child", "root.child.children[0]"]);
  expect(prototypeFlowGridFields(spec(text))).toEqual([]);
});
