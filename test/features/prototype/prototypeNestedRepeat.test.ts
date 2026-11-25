import { webRepeatInstances } from "../../../src/features/prototype/web/webRepeat";
import { renderPrototypeStill } from "../../../src/features/prototype/web/webStill";
import { toHtml } from "../../../src/features/prototype/web/webNodes";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import fixtures from "../../fixtures/prototype-spec/repeat/nested.json";
import sourceFixtures from "../../fixtures/prototype-spec/repeat/nested-sources.json";
import cellLimitFixture from "../../fixtures/prototype-spec/repeat/nested-cell-limit.json";
import literalArrayFixture from "../../fixtures/prototype-spec/repeat/nested-literal-unused-array.json";
import { repeatErrors } from "../../../src/features/prototype/prototypeRepeat";
import { prototypeNestedRepeatFields } from "../../../src/features/prototype/prototypeFormatCapability";
import contract from "../../../schemas/prototype-spec-contract.json";
import { PrototypeRepeatData } from "../../../src/features/prototype/prototypeData";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { prototypeGateCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { prototypeRolePalette } from "../../../src/features/prototype/prototypeContrast";
import {
  childEntries,
  bound,
  type WebRenderScope,
} from "../../../src/features/prototype/web/webRender";
import { record, bindText, type Raw } from "../../../src/features/prototype/prototypeTemplate";
interface Case {
  name: string;
  spec: Raw;
  data?: Raw;
  state?: Raw;
  expected: { rows: { outerIndex: number; innerIndex: number; texts: string[] }[] };
}
for (const fixture of [...fixtures, ...sourceFixtures] as Case[]) {
  test(fixture.name, () => {
    const spec: Raw = {
      ...fixture.spec,
      ...(fixture.data ? { data: fixture.data } : {}),
      ...(fixture.state ? { state: fixture.state } : {}),
    };
    expect(validatePrototypeSpec(spec)).toMatchObject({ success: true });
    expect(prototypeGateCapabilities(spec)).toContain("prototype_nested_repeat_v1");
    const scope: WebRenderScope = {
      style: { mode: "light", palette: prototypeRolePalette({}, "light"), parentAxis: "column" },
      condition: { state: fixture.state ?? {}, platform: "android" },
      data: fixture.data,
      spec,
      format: { locale: "en-US", timeZone: "UTC", nowMs: 0 },
      instances: [],
      inBox: false,
      unsupported: [],
      screenWidth: 412,
      screenHeight: 915,
      layers: [],
    };
    expect(expandedTexts(spec, scope)).toEqual(fixture.expected);
    const rows: Case["expected"]["rows"] = [];
    for (const outer of childEntries(record(spec.root)!, scope, "root")) {
      for (const inner of childEntries(record(outer.node)!, outer.scope, outer.path)) {
        const node = record(inner.node)!;
        if (node.type === "text") {
          const outerIndex = outer.scope.instances[0]!.index!;
          const innerIndex = inner.scope.instances[1]!.index!;
          const previous = rows.at(-1);
          const text = bound(node.text, inner.scope);
          if (previous?.outerIndex === outerIndex && previous.innerIndex === innerIndex) {
            previous.texts.push(text);
          } else {
            rows.push({ outerIndex, innerIndex, texts: [text] });
          }
        }
      }
    }
    expect({ rows }).toEqual(fixture.expected);
  });
}
/** The web repeat expander also produces the shared rendering shape without a renderer. */
function expandedTexts(spec: Raw, scope: WebRenderScope): Case["expected"] {
  const root = record(spec.root)!;
  const inner = record((root.children as Raw[])[0])!;
  return {
    rows: webRepeatInstances(root, scope).flatMap((outer) =>
      webRepeatInstances(inner, { ...scope, instances: [outer] }).map((instance) => ({
        outerIndex: outer.index!,
        innerIndex: instance.index!,
        texts: (inner.children as Raw[])
          .filter((node) => node.type === "text")
          .map((node) => bindText(String(node.text), instance)),
      })),
    ),
  };
}

const invalidDir = new URL("../../fixtures/prototype-spec/invalid/", import.meta.url);
for (const file of readdirSync(invalidDir).filter((name) => name.startsWith("nested-repeat-"))) {
  const fixture: { spec: Raw; expectedPath: string; expectedMessage: string } = JSON.parse(
    readFileSync(new URL(file, invalidDir), "utf8"),
  );
  test(file, () =>
    expect(validatePrototypeSpec(fixture.spec)).toEqual({
      success: false,
      error: { path: fixture.expectedPath, message: fixture.expectedMessage },
    }),
  );
}

test("an inner derive name distinct from every row field is accepted", () => {
  const fixture: { spec: Raw } = JSON.parse(
    readFileSync(new URL("nested-repeat-derive-row-field.json", invalidDir), "utf8"),
  );
  const inner = record((record(fixture.spec.root)!.children as Raw[])[0])!;
  const repeat = record(inner.repeat)!;
  repeat.derive = { skuLabel: record(repeat.derive)!.sku };
  inner.children = [{ type: "text", text: "{line.qty} {line.skuLabel}" }];
  expect(validatePrototypeSpec(fixture.spec)).toMatchObject({ success: true });
});

const duplicateKeyFixtures: {
  name: string;
  spec: Raw;
  error?: { path: string; message: string };
}[] = JSON.parse(
  readFileSync(
    new URL("../../fixtures/prototype-spec/repeat/nested-duplicate-keys.json", import.meta.url),
    "utf8",
  ),
);
for (const fixture of duplicateKeyFixtures) {
  test(`nested-duplicate-keys: ${fixture.name}`, () =>
    expect(validatePrototypeSpec(fixture.spec)).toMatchObject(
      fixture.error ? { success: false, error: fixture.error } : { success: true },
    ));
}

function nestedSpec(
  outerCount: number,
  innerCount: number,
  node: Raw = { type: "text", text: "{order.id}/{outerIndex}/{line.sku}/{index}" },
): Raw {
  return {
    id: "boundary",
    window: { placement: { type: "fullscreen" } },
    data: {
      orders: Array.from({ length: outerCount }, (_, id) => ({
        id,
        lines: Array.from({ length: innerCount }, (_, sku) => ({ sku })),
      })),
    },
    root: {
      type: "column",
      repeat: { items: { path: "/orders" }, as: "order" },
      children: [
        { type: "column", repeat: { items: { field: "lines" }, as: "line" }, children: [node] },
      ],
    },
  };
}
test("inner limit is 100 per outer item", () => {
  expect(validatePrototypeSpec(nestedSpec(2, 100)).success).toBe(true);
  expect(validatePrototypeSpec(nestedSpec(1, 101))).toEqual({
    success: false,
    error: {
      path: "root.children[0].repeat.items.field",
      message: "Repeat field resolves to more than 100 items",
    },
  });
});
test("expanded node and image budgets charge outer times inner", () => {
  expect(validatePrototypeSpec(nestedSpec(20, 100))).toMatchObject({
    success: false,
    error: { message: "Expanded node limit exceeded" },
  });
  expect(validatePrototypeSpec(nestedSpec(2, 16, { type: "image", asset: "photo" })).success).toBe(
    true,
  );
  expect(validatePrototypeSpec(nestedSpec(3, 11, { type: "image", asset: "photo" }))).toMatchObject(
    { success: false, error: { message: "Expanded image limit exceeded" } },
  );
});
test("a third level is rejected even with no outer instances", () => {
  const spec = nestedSpec(0, 0, {
    type: "column",
    repeat: { items: { field: "lines" }, as: "third" },
    children: [],
  });
  expect(validatePrototypeSpec(spec)).toMatchObject({
    success: false,
    error: { message: "Repeat nesting depth exceeds 2" },
  });
});
test("bound keys validate every pair and invalid characters in either alias", () => {
  const spec = nestedSpec(2, 2, {
    type: "switch",
    stateKey: "selected_{order.id}_{outerIndex}_{line.sku}_{index}",
  });
  spec.state = {
    selected_0_0_0_0: true,
    selected_0_0_1_1: true,
    selected_1_1_0_0: true,
    selected_1_1_1_1: true,
  };
  expect(validatePrototypeSpec(spec).success).toBe(true);
  spec.state = { selected_0_0_0_0: true, selected_0_0_1_1: true, selected_1_1_0_0: true };
  expect(validatePrototypeSpec(spec).success).toBe(false);
  for (const field of ["id", "sku"]) {
    const bad = nestedSpec(1, 1, {
      type: "switch",
      stateKey: "selected_{order.id}_{line.sku}_{outerIndex}_{index}",
    });
    const order = record((record(bad.data)!.orders as Raw[])[0])!;
    if (field === "id") {
      order.id = "bad-key";
    } else {
      (order.lines as Raw[])[0]!.sku = "bad-key";
    }
    expect(validatePrototypeSpec(bad)).toMatchObject({
      success: false,
      error: { message: expect.stringContaining("Bound state key") },
    });
  }
});
test("strict policy refuses the new gate", () => {
  const spec = nestedSpec(1, 1);
  expect(
    validatePrototypeSpec(spec, {
      requiredCapabilities: prototypeGateCapabilities,
      supportedCapabilities: ["prototype_data_model_v1"],
    }),
  ).toMatchObject({
    success: false,
    error: { path: "$", message: expect.stringContaining("prototype_nested_repeat_v1") },
  });
});

test("unused literal array fields require the nested capability in both host gates", () => {
  expect(validatePrototypeSpec(literalArrayFixture).success).toBe(true);
  expect(prototypeNestedRepeatFields(literalArrayFixture)).toEqual(["root.repeat.items"]);
  const required = prototypeGateCapabilities(literalArrayFixture);
  expect(required).toContain("prototype_nested_repeat_v1");
  expect(
    validatePrototypeSpec(literalArrayFixture, {
      requiredCapabilities: prototypeGateCapabilities,
      supportedCapabilities: required.filter((name) => name !== "prototype_nested_repeat_v1"),
    }),
  ).toMatchObject({
    success: false,
    error: { message: expect.stringContaining("prototype_nested_repeat_v1") },
  });
});

test("empty outer sources keep inner state key scopes for controls and actions", () => {
  for (const outerCount of [0, 1]) {
    const spec = nestedSpec(outerCount, 0, {
      type: "checkbox",
      stateKey: "checked_{line.id}",
      onTap: [
        { type: "toggle", key: "checked_{line.id}" },
        { type: "increment", key: "count_{line.id}" },
      ],
    });
    expect(validatePrototypeSpec(spec)).toMatchObject({ success: true });
  }
});

test("substituted text budget is shared across inner template siblings", () => {
  const spec = nestedSpec(1, 100);
  const order = (record(spec.data)!.orders as Raw[])[0]!;
  order.lines = Array.from({ length: 100 }, () => ({ sku: "x".repeat(16000) }));
  const inner = (record(spec.root)!.children as Raw[])[0]!;
  inner.children = [{ type: "text", text: "{line.sku}" }];
  expect(repeatErrors(spec)).toBeUndefined();
  inner.children = Array.from({ length: 3 }, () => ({ type: "text", text: "{line.sku}" }));
  expect(repeatErrors(spec)?.message).toBe("Substituted text total limit exceeded");
});

test("lazy outer lists charge nested expansion for later rows and the template once", () => {
  const spec = nestedSpec(2, 0, { type: "image", asset: "photo" });
  const root = record(spec.root)!;
  root.type = "list";
  record(root.repeat)!.key = "id";
  const orders = record(spec.data)!.orders as Raw[];
  orders[1]!.lines = Array.from({ length: 33 }, (_, sku) => ({ sku }));
  expect(validatePrototypeSpec(spec)).toMatchObject({
    success: false,
    error: { message: "Expanded image limit exceeded" },
  });
  orders[1]!.lines = [{ sku: 1 }];
  expect(validatePrototypeSpec(spec).success).toBe(true);
  record(spec.data)!.orders = Array.from({ length: 100 }, (_, id) => ({ id, lines: [] }));
  root.header = { type: "image", asset: "photo" };
  root.children = [
    { type: "column", children: [...(root.children as Raw[]), { type: "image", asset: "photo" }] },
  ];
  expect(validatePrototypeSpec(spec).success).toBe(true);
});

test("data values containing {row.x} stay inert during fieldError validation", () => {
  const child: Raw = { type: "text", text: "{data:/literal} {row.qty}" };
  const spec = {
    id: "inert-data",
    window: { placement: { type: "fullscreen" } },
    data: {
      literal: "{row.x}",
      rows: [{ x: "x", qty: 2 }],
    },
    root: { type: "column", repeat: { items: { path: "/rows" }, as: "row" }, children: [child] },
  };
  expect(validatePrototypeSpec(spec)).toMatchObject({ success: true });
  expect(toHtml(renderPrototypeStill(spec).element)).toContain("{row.x} 2");
  record((spec.data.rows as Raw[])[0])!.x = "x".repeat(
    contract.limits.MAX_PROTOTYPE_SUBSTITUTED_TEXT_LENGTH,
  );
  child.text = "{row.x}{row.qty}";
  expect(repeatErrors(spec)?.message).toBe("Substituted text length limit exceeded");
});

test("web lazy row platform values render tokens literally", () => {
  const spec = nestedSpec(1, 0);
  const root = record(spec.root)!;
  root.type = "list";
  record(root.repeat)!.key = "id";
  root.children = [{ type: "text", text: "{platform:/name} {order.id}" }];
  const scope: WebRenderScope = {
    style: { mode: "light", palette: prototypeRolePalette({}, "light"), parentAxis: "column" },
    condition: {
      state: {},
      platform: "android",
      platformState: { "/name": "{order.id} {index} {data:/secret}" },
    },
    data: { ...record(spec.data), secret: "expanded" },
    spec,
    format: { locale: "en-US", timeZone: "UTC", nowMs: 0 },
    instances: [],
    inBox: false,
    unsupported: [],
    screenWidth: 412,
    screenHeight: 915,
    layers: [],
  };
  const row = webRepeatInstances(root, scope)[0]!;
  expect(bound("{platform:/name} {order.id}", { ...scope, instances: [row] })).toBe(
    "{order.id} {index} {data:/secret} 0",
  );
});

test("motion budgets count every nested instance", () => {
  const icon = {
    type: "icon",
    name: "favorite",
    keyframes: {
      trigger: { key: "liked" },
      durationMs: 600,
      tracks: {
        scale: [
          [0, 1],
          [0.5, 1.3],
          [1, 1],
        ],
      },
    },
  };
  const spec = nestedSpec(3, 6, icon);
  spec.state = { liked: false };
  expect(validatePrototypeSpec(spec)).toMatchObject({
    success: false,
    error: { message: "Keyframe node limit exceeded" },
  });
});

test("representative orders render one card and header per order", () => {
  const spec: Raw = JSON.parse(
    readFileSync(
      new URL("../../fixtures/prototype-spec/repeat/nested-orders.json", import.meta.url),
      "utf8",
    ),
  );
  expect(validatePrototypeSpec(spec).success).toBe(true);
  const rendered = renderPrototypeStill(spec);
  const html = toHtml(rendered.element);
  expect(html.match(/data-node="card"/g)).toHaveLength(2);
  expect(html.match(/Order A #0 Ada/g)).toHaveLength(1);
  expect(html.match(/Order C #1 Cy/g)).toHaveLength(1);
  expect(html).toContain("PEN x2 (A 0.0)");
  expect(html).toContain("INK x1 (A 0.1)");
  expect(html).toContain("PAD x3 (C 1.0)");
});

// Repeated sources must be charged per use, including childless inner templates.
test("shared cell fixtures straddle the exact contract limit", () => {
  const root = cellLimitFixture.root;
  const data = new PrototypeRepeatData(cellLimitFixture.data);
  const outer = cellLimitFixture.data.orders[0]!;
  const cells =
    data.cells("/orders") +
    root.children.reduce(
      (sum, node) =>
        sum +
        new PrototypeRepeatData({
          rows: outer[node.repeat.items.field as keyof typeof outer],
        }).cells("/rows"),
      0,
    );
  expect(cells).toBe(contract.limits.MAX_PROTOTYPE_REPEAT_PATH_CELLS);
  expect(validatePrototypeSpec(cellLimitFixture)).toMatchObject({ success: true });
  const over = JSON.parse(
    readFileSync(new URL("nested-repeat-cell-limit.json", invalidDir), "utf8"),
  );
  const overData = new PrototypeRepeatData(over.spec.data);
  const overOuter = over.spec.data.orders[0];
  expect(
    overData.cells("/orders") +
      over.spec.root.children.reduce(
        (sum: number, node: Raw) =>
          sum +
          new PrototypeRepeatData({
            rows: overOuter[String(record(record(node.repeat)?.items)?.field)],
          }).cells("/rows"),
        0,
      ),
  ).toBe(contract.limits.MAX_PROTOTYPE_REPEAT_PATH_CELLS + 1);
});
