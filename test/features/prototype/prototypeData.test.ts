import { describe, expect, spyOn, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import pointers from "../../fixtures/prototype-spec/data/pointers.json";
import {
  PrototypeRepeatData,
  isPrototypeDataPointer,
  prototypeDataPointerTokens,
  resolvePrototypeDataPointer,
  prototypeDataPlaceholders,
  projectPrototypeDataItem,
  prototypeDataModelFields,
  prototypeDataModelUnsupportedMessage,
} from "../../../src/features/prototype/prototypeData";
import {
  prototypeDataError,
  validatePrototypeSpec,
} from "../../../src/features/prototype/prototypeValidation";
import contract from "../../../schemas/prototype-spec-contract.json";

import { repeatErrors, repeatKeyInstances } from "../../../src/features/prototype/prototypeRepeat";
import cellInvalid from "../../fixtures/prototype-spec/invalid/data-repeat-path-cell-limit.json";
import cellExact from "../../fixtures/prototype-spec/valid/data-repeat-path-cells-exact.json";

const spec = (root: unknown = { type: "text", text: "hello" }) => ({ root });

describe("data pointers", () => {
  test.each(pointers.cases)("$pointer", (entry) => {
    expect(isPrototypeDataPointer(entry.pointer)).toBe(entry.valid);
    const result = resolvePrototypeDataPointer(pointers.data, entry.pointer);
    expect(result !== undefined).toBe(entry.found);
    if ("value" in entry) {
      expect(result).toEqual(entry.value);
    }
  });
  test("token decoding is ordered and inherited keys are never found", () => {
    expect(prototypeDataPointerTokens("/a~01/~1")).toEqual(["a~1", "/"]);
    expect(prototypeDataPointerTokens("bad")).toEqual([]);
    expect(resolvePrototypeDataPointer({}, "/toString")).toBeUndefined();
    expect(resolvePrototypeDataPointer(undefined, "/x")).toBeUndefined();
    expect(resolvePrototypeDataPointer([1], "/1.0")).toBeUndefined();
    expect(resolvePrototypeDataPointer([1], "/-1")).toBeUndefined();
    expect(isPrototypeDataPointer("/" + "😀".repeat(128))).toBe(false);
    expect(isPrototypeDataPointer("/" + "a".repeat(255))).toBe(true);
  });
});

const nested = (count: number, value: unknown): unknown => {
  let result = value;
  for (let i = 0; i < count; i++) {
    result = { a: result };
  }
  return result;
};
describe("data validation", () => {
  test.each([null, [], 1, new Date(0)].map((value) => ({ value })))(
    "root $value must be a plain object",
    ({ value }) => {
      expect(prototypeDataError(value)).toEqual({ path: "data", message: "Expected object" });
    },
  );
  test.each([null, Infinity, NaN, undefined, () => 1, new Date(0)].map((value) => ({ value })))(
    "invalid member $value",
    ({ value }) => {
      expect(prototypeDataError({ "a b": value })).toEqual({
        path: 'data["a b"]',
        message: "Invalid data value",
      });
    },
  );
  test("depth is checked before array length, then children", () => {
    const value = nested(
      8,
      Array.from({ length: 501 }, () => null),
    );
    expect(prototypeDataError(value)).toEqual({
      path: "data" + ".a".repeat(8),
      message: "Data depth limit exceeded",
    });
    expect(prototypeDataError({ a: Array.from({ length: 501 }, () => null) })).toEqual({
      path: "data.a",
      message: "Data array limit exceeded",
    });
    expect(prototypeDataError({ z: null, a: [true, null] })).toEqual({
      path: "data.a[1]",
      message: "Invalid data value",
    });
    expect(prototypeDataError(nested(8, 1))).toBeUndefined();
  });
  test("byte cost is last and uses the emit numeric reservation", () => {
    const large = "x".repeat(contract.limits.MAX_PROTOTYPE_DATA_BYTES);
    expect(prototypeDataError({ a: large, z: null })).toEqual({
      path: "data.z",
      message: "Invalid data value",
    });
    expect(prototypeDataError({ a: large })).toEqual({
      path: "data",
      message: "Data byte limit exceeded",
    });
    // {"a":"..."} has eight bytes of overhead.
    expect(
      prototypeDataError({ a: "x".repeat(contract.limits.MAX_PROTOTYPE_DATA_BYTES - 8) }),
    ).toBeUndefined();
    expect(prototypeDataError({ a: Array.from({ length: 500 }, () => 1) })).toBeUndefined();
    expect(
      prototypeDataError({ a: "x".repeat(contract.limits.MAX_PROTOTYPE_DATA_BYTES - 44), b: 0 }),
    ).toEqual({ path: "data", message: "Data byte limit exceeded" });
  });
});

test("placeholder grammar is a plain scan and malformed braces are literal", () => {
  expect(
    prototypeDataPlaceholders(
      "{data:/a} {{data:/b}} {data:/a~1b} {data:bad} {data:} {data:/a~2} {data:/open",
    ),
  ).toEqual(["/a", "/b", "/a~1b"]);
  expect(prototypeDataPlaceholders("{item.title} {key} data:/a")).toEqual([]);
});
test("placeholder scan bounds pointer lengths and skips long runs of literal braces", () => {
  const pointer = "/" + "a".repeat(255);
  expect(prototypeDataPlaceholders(`{data:${pointer}}`)).toEqual([pointer]);
  expect(prototypeDataPlaceholders(`{data:${pointer}a}`)).toEqual([]);
  expect(prototypeDataPlaceholders("{data:/a")).toEqual([]);
  expect(prototypeDataPlaceholders("{".repeat(50_000) + "{data:/a}")).toEqual(["/a"]);
});
test("projection keeps named finite scalars and preserves special own keys", () => {
  const source = JSON.parse(
    '{"id":7,"title":"Latte","active":true,"__proto__":"own","a b":1,"details":{},"values":[],"empty":null}',
  );
  expect(projectPrototypeDataItem({ ...source, infinite: Infinity })).toEqual(
    JSON.parse('{"id":7,"title":"Latte","active":true,"__proto__":"own"}'),
  );
});

const uses: [unknown, string[]][] = [
  [{ ...spec(), data: {} }, ["data"]],
  [
    spec({ type: "column", repeat: { items: { path: "/orders" }, as: "item" }, children: [] }),
    ["root.repeat.items"],
  ],
  [
    spec({ type: "column", repeat: { items: [{ id: 7 }], as: "item", key: "id" }, children: [] }),
    ["root.repeat.key"],
  ],
  [spec({ type: "text", text: "{data:/count}" }), ["root.text"]],
  [
    spec({ type: "text", text: "x", visibleWhen: { not: { data: "/n", equals: 1 } } }),
    ["root.visibleWhen.not.data"],
  ],
  [
    spec({
      type: "text",
      text: "x",
      styleWhen: [{ when: { all: [{ data: "/n", gt: 0 }] }, style: {} }],
    }),
    ["root.styleWhen[0].when.all[0].data"],
  ],
  [spec(), []],
];
test.each(uses)("usage fields %p", (candidate, fields) => {
  expect(prototypeDataModelFields(candidate)).toEqual(fields);
});
test("usage document order starts with data and follows authored node fields depth-first", () => {
  expect(
    prototypeDataModelFields({
      ...spec({
        type: "column",
        children: [
          { type: "button", label: "{data:/n}", visibleWhen: { data: "/n", gt: 0 } },
          { type: "text", text: "{data:/n}" },
        ],
        repeat: { key: "id", items: { path: "/orders" }, as: "item" },
      }),
      data: {},
    }),
  ).toEqual([
    "data",
    "root.children[0].label",
    "root.children[0].visibleWhen.data",
    "root.children[1].text",
    "root.repeat.key",
    "root.repeat.items",
  ]);
});
test("only text-kind fields and conditions require data capability", () => {
  expect(
    prototypeDataModelFields(
      spec({
        type: "text",
        text: "literal {data:bad}",
        contentDescription: "{data:/x}",
        onTap: [
          { type: "emit", name: "{data:/x}", payload: { type: "text", text: "{data:/x}" } },
          { type: "setState", key: "x", value: "{data:/x}" },
        ],
        visibleWhen: { key: "x", equals: "{data:/x}" },
      }),
    ),
  ).toEqual([]);
});
test.each(["android", "ios"] as const)("refusal wording %s", (platform) => {
  const device = platform === "android" ? "connected CtrlProxy" : "connected iOS prototype agent";
  const update =
    platform === "android"
      ? "Update the connected CtrlProxy"
      : "Relaunch the app with launchApp prototype: true to load the agent built for this AutoMobile version";
  expect(prototypeDataModelUnsupportedMessage(["data", "root.text"], platform)).toBe(
    `The ${device} does not advertise prototype_data_model_v1, so it cannot resolve the data binding at data (and 1 more): a top-level data object, repeat.items {path}, repeat.key, {data: pointer} conditions and {data:/pointer} text placeholders. Nothing was shown. ${update}, or inline the content as literal repeat.items, state keys and literal text.`,
  );
  expect(prototypeDataModelUnsupportedMessage(["root.text"], platform)).not.toContain("(and");
});

test.each([
  [{ data: "orders", equals: 1 }, "data", "Invalid pointer value"],
  [
    { data: "/n", key: "n", equals: 1 },
    "key",
    "Exactly one of key, data, all, any, not, valid is required",
  ],
  [{ data: "/n" }, "equals", "Exactly one of equals, notEquals, gt, lt is required"],
  [{ data: "/n", equals: 1, gt: 0 }, "gt", "Exactly one of equals, notEquals, gt, lt is required"],
  [{ all: [{ key: "n", equals: 1 }], gt: 0 }, "gt", "Requires key or data"],
])("condition rule %p", (condition, field, message) => {
  const candidate = {
    id: "conditions",
    window: { placement: { type: "fullscreen" } },
    root: { type: "text", text: "x", visibleWhen: condition },
  };
  expect(validatePrototypeSpec(candidate)).toEqual({
    success: false,
    error: { path: `root.visibleWhen.${field}`, message },
  });
});

const resolveDirectory = join(import.meta.dir, "../../fixtures/prototype-spec/data/resolve");
const resolveFixtures = readdirSync(resolveDirectory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({
    name,
    spec: (JSON.parse(readFileSync(join(resolveDirectory, name), "utf8")) as { spec: unknown })
      .spec,
  }));
test.each(resolveFixtures)("resolver fixture $name is a valid authored spec", ({ spec }) => {
  expect(validatePrototypeSpec(spec).success).toBe(true);
});

describe("repeat path cells", () => {
  const column = (path = "/items") => ({
    type: "column",
    repeat: { items: { path }, as: "item" },
    children: [],
  });
  const amplifiedItem = Object.fromEntries(Array.from({ length: 200 }, (_, i) => [`f${i}`, ""]));
  const amplified = {
    data: { items: Array.from({ length: 128 }, () => amplifiedItem) },
    root: { type: "column", children: Array.from({ length: 1500 }, () => column()) },
  };

  test("rejects the crossing container at its path", () => {
    expect(repeatErrors(cellInvalid.spec)).toEqual({
      path: cellInvalid.expectedPath,
      message: cellInvalid.expectedMessage,
    });
  });
  test("exactly the shared cell limit passes", () => {
    expect(repeatErrors(cellExact)).toBeUndefined();
  });
  test.each([
    { items: {}, message: "Repeat path does not resolve to an array" },
    {
      items: Array.from({ length: 129 }, () => amplifiedItem),
      message: "Repeat path resolves to more than 128 items",
    },
    {
      items: [...cellInvalid.spec.data.items.slice(0, 127), true],
      message: "Repeat path item 127 is not an object",
    },
  ])("source error wins before the crossing container: $message", ({ items, message }) => {
    const children = [...cellInvalid.spec.root.children.slice(0, 19), column("/bad")];
    expect(
      repeatErrors({
        data: { ...cellInvalid.spec.data, bad: items },
        root: { type: "column", children },
      }),
    ).toEqual({
      path: "root.children[19].repeat.items.path",
      message,
    });
  });
  test("literal repeats do not spend cells", () => {
    const children = Array.from({ length: 20 }, () => ({
      type: "column",
      repeat: { items: cellInvalid.spec.data.items, as: "item" },
      children: [],
    }));
    expect(repeatErrors({ root: { type: "column", children } })).toBeUndefined();
  });
  test("zero projectable members spend one cell each", () => {
    const data = new PrototypeRepeatData({ items: [{ "bad name": true, nested: {} }, {}] });
    expect(data.cells("/items")).toBe(2);
    expect(data.items("/items")).toEqual([{}, {}]);
  });
  test("1500 repeats are rejected after one shared projection, without rescanning cells", () => {
    let reads = 0;
    const item = Object.fromEntries(Object.keys(amplifiedItem).map((key) => [key, ""]));
    Object.defineProperty(item, "f0", {
      enumerable: true,
      get: () => {
        reads++;
        return "";
      },
    });
    const value = { ...amplified, data: { items: Array.from({ length: 128 }, () => item) } };
    const data = new PrototypeRepeatData(value.data);
    const projections = spyOn(data, "items");
    expect(repeatErrors(value, data)).toEqual({
      path: "root.children[2].repeat.items.path",
      message: "Repeat path cell limit exceeded",
    });
    expect(projections).toHaveBeenCalledTimes(2);
    expect(projections.mock.results[0].value).toBe(projections.mock.results[1].value);
    expect(reads).toBe(256); // One cell scan and one projection, each visiting 128 objects.
    expect(data.cells("/items")).toBe(25600);
    expect(reads).toBe(256);
    projections.mockRestore();
  });
  test("the validation passes share immutable projections and caches never outlive a call", () => {
    const data = new PrototypeRepeatData(cellExact.data);
    const first = data.items("/items");
    expect(repeatErrors(cellExact, data)).toBeUndefined();
    expect(repeatKeyInstances(cellExact, [], data)).toEqual([]);
    expect(data.items("/items")).toBe(first);
    expect(Object.isFrozen(first)).toBe(true);
    expect(first.every(Object.isFrozen)).toBe(true);
    expect(new PrototypeRepeatData(cellExact.data).items("/items")).not.toBe(first);
  });
  test.each(["box", "row", "column"])(
    "%s accepts empty children but requires the field",
    (type) => {
      expect(
        validatePrototypeSpec({ ...cellExact, root: { ...column(), type }, data: { items: [{}] } })
          .success,
      ).toBe(true);
      expect(
        validatePrototypeSpec({
          ...cellExact,
          root: { type, repeat: column().repeat },
          data: { items: [{}] },
        }),
      ).toEqual({
        success: false,
        error: { path: "root.children", message: "Required property" },
      });
    },
  );
});
