import { webRepeatInstances } from "../../../src/features/prototype/web/webRepeat";
import { renderPrototypeStill } from "../../../src/features/prototype/web/webStill";
import { toHtml } from "../../../src/features/prototype/web/webNodes";
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import fixtures from "../../fixtures/prototype-spec/repeat/nested.json";
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
for (const fixture of fixtures as Case[]) {
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
