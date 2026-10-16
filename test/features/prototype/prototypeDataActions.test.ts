import { describe, expect, test } from "bun:test";
import contract from "../../../schemas/prototype-spec-contract.json";
import { PROTOTYPE_DATA_ACTIONS_CAPABILITY } from "../../../src/features/observe/android/ctrlProxyProtocol";
import { prototypeRequiredCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import {
  applyPrototypeDataWrite,
  resolvePrototypeDataWriteValue,
} from "../../../src/features/prototype/prototypeDataWrite";
import {
  actionSchema,
  prototypeSpecSchema,
  PROTOTYPE_ACTION_TYPES,
} from "../../../src/features/prototype/prototypeSpec";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const DATA_ACTIONS = ["setData", "appendData", "removeData"];
const label = { type: "text", id: "label", text: "Hello" };
function spec(
  actions: unknown[],
  extra: Record<string, unknown> = { data: { cart: [], profile: { name: "Ada" } } },
) {
  return {
    id: "shop",
    window: { placement: { type: "fullscreen" } },
    state: { picked: "apple" },
    root: { ...label, onTap: actions },
    ...extra,
  };
}
const set = (path: string, value: unknown = { value: 1 }) => ({ type: "setData", path, value });
const append = (path: string, value: unknown = { value: 1 }) => ({
  type: "appendData",
  path,
  value,
});
const remove = (path: string) => ({ type: "removeData", path });
function rejection(candidate: unknown) {
  const result = validatePrototypeSpec(candidate);
  expect(result.success).toBe(false);
  return result.success ? undefined : result.error;
}

describe("data action schema and shared contract", () => {
  test("the contract, Zod schema and action list agree", () => {
    for (const type of DATA_ACTIONS) {
      expect(Object.keys(contract.definitions.action.variants)).toContain(type);
      expect(PROTOTYPE_ACTION_TYPES as readonly string[]).toContain(type);
    }
    const zodFields = Object.fromEntries(
      actionSchema.options.map((option) => [
        option.shape.type.options[0],
        Object.keys(option.shape).sort(),
      ]),
    );
    const variants = contract.definitions.action.variants as Record<
      string,
      { fields: Record<string, unknown> }
    >;
    for (const type of DATA_ACTIONS) {
      expect(zodFields[type]).toEqual(Object.keys(variants[type].fields).sort());
    }
  });
  test("the contract limits the size of /data after a write", () => {
    expect(contract.limits.MAX_PROTOTYPE_DATA_WRITE_BYTES).toBeGreaterThan(0);
  });
  test.each([
    set("/data/count"),
    set("/data/cart/{index}/qty", { index: true }),
    set("/data/a", { state: "picked" }),
    set("/data/a", { data: "/profile/name" }),
    append("/data/cart", { value: { sku: "x", qty: 1 } }),
    remove("/data/cart/{index}"),
    remove("/data/profile/name"),
  ])("accepts %j in Zod", (action) => {
    expect(actionSchema.safeParse(action).success).toBe(true);
  });
  test.each([
    { type: "setData", path: "/data/a" },
    { type: "appendData", path: "/data/a", value: 1 },
    { type: "removeData", path: "/data/a", value: { value: 1 } },
    { type: "setData", path: "", value: { value: 1 } },
    { type: "setData", path: "/data/a", value: { page: "p" } },
  ])("rejects %j in Zod", (action) => {
    expect(actionSchema.safeParse(action).success).toBe(false);
  });
});

describe("data action validation", () => {
  test("a valid set of data actions validates in the host validator and the schema", () => {
    const candidate = spec([
      set("/data/profile/name", { value: "Grace" }),
      set("/data/profile/title", { state: "picked" }),
      append("/data/cart", { value: { sku: "x", qty: 1 } }),
      remove("/data/cart/0"),
    ]);
    expect(validatePrototypeSpec(candidate).success).toBe(true);
    expect(prototypeSpecSchema.safeParse(candidate).success).toBe(true);
  });
  test.each([
    "/data",
    "/state/picked",
    "/dat/a",
    "data/a",
    "/data/a~2",
    "/data/a~",
    `/data/${"a".repeat(260)}`,
  ])("rejects pointer %j", (path) => {
    for (const action of [set(path), append(path), remove(path)]) {
      const error = rejection(spec([action]));
      expect(error?.path).toBe("root.onTap[0].path");
    }
  });
  test("accepts escaped pointer tokens", () => {
    expect(validatePrototypeSpec(spec([set("/data/a~1b/c~0d")])).success).toBe(true);
  });
  test("appendData on a statically non-array target is refused", () => {
    for (const path of ["/data/profile", "/data/profile/name"]) {
      expect(rejection(spec([append(path)]))).toEqual({
        path: "root.onTap[0].path",
        message: "appendData target is not an array",
      });
    }
    expect(validatePrototypeSpec(spec([append("/data/cart")])).success).toBe(true);
  });
  test("an append target the spec data does not define is left to the device", () => {
    expect(validatePrototypeSpec(spec([append("/data/later")])).success).toBe(true);
    expect(validatePrototypeSpec(spec([append("/data/x")], {})).success).toBe(true);
  });
  test("a literal value must be data", () => {
    for (const value of [null, { nested: null }, [null]]) {
      expect(rejection(spec([set("/data/a", { value })]))?.path).toBe("root.onTap[0].value.value");
    }
    expect(validatePrototypeSpec(spec([set("/data/a", { value: [1, "a", true] })])).success).toBe(
      true,
    );
  });
  test("a repeat row binds {index} as a whole path segment", () => {
    const row = {
      type: "row",
      id: "row",
      repeat: { items: [{ id: "a" }, { id: "b" }], as: "item" },
      children: [
        {
          ...label,
          onTap: [
            remove("/data/cart/{index}"),
            set("/data/names/{index}", { item: "id" }),
            set("/data/at/{index}", { index: true }),
          ],
        },
      ],
    };
    const candidate = { ...spec([]), root: { type: "column", children: [row] } };
    expect(validatePrototypeSpec(candidate).success).toBe(true);
  });
  test.each([
    ["{index} outside a repeat", remove("/data/cart/{index}"), "{index} outside a repeat template"],
    ["item outside a repeat", set("/data/a", { item: "id" }), undefined],
  ])("%s is refused", (_name, action, message) => {
    const error = rejection(spec([action]));
    expect(error?.path).toStartWith("root.onTap[0]");
    if (message) {
      expect(error?.message).toBe(message);
    }
  });
  test.each([
    ["/data/cart/row{index}", "{index} must be a whole data path segment"],
    ["/data/cart/{item.id}", "Only a whole {index} segment may be a placeholder in a data path"],
  ])("inside a repeat %s is refused", (path, message) => {
    const row = {
      type: "row",
      id: "row",
      repeat: { items: [{ id: "a" }], as: "item" },
      children: [{ ...label, onTap: [remove(path)] }],
    };
    expect(rejection({ ...spec([]), root: { type: "column", children: [row] } })?.message).toBe(
      message,
    );
  });
});

describe("data action capability gate", () => {
  const gated = spec([set("/data/a")], {});
  test("a spec using a data action requires prototype_data_actions_v1", () => {
    const required = prototypeRequiredCapabilities(gated);
    expect(required.map((gate) => gate.capability)).toEqual([PROTOTYPE_DATA_ACTIONS_CAPABILITY]);
    expect(required[0].fields).toEqual(["root.onTap[0].path"]);
    expect(prototypeRequiredCapabilities(spec([], {}))).toEqual([]);
  });
  test("an opaque emit payload that looks like an action does not trip the gate", () => {
    const payload = { type: "setData", path: "/data/a" };
    expect(prototypeRequiredCapabilities(spec([{ type: "emit", name: "x", payload }], {}))).toEqual(
      [],
    );
  });
  // The tool-level refusal on both platforms, for show and for patch, is pinned by
  // test/server/prototypeToolCapabilityGateParity.test.ts (this capability has a fixture there).
  test.each([
    ["android", "connected CtrlProxy", "Update the connected CtrlProxy"],
    ["ios", "connected iOS prototype agent", "Relaunch the app with launchApp prototype: true"],
  ] as const)(
    "the %s refusal names the capability, the field and the fix",
    (platform, device, fix) => {
      const [gate] = prototypeRequiredCapabilities(gated);
      const message = gate.unsupportedMessage(gate.fields, platform);
      expect(message).toContain(device);
      expect(message).toContain(PROTOTYPE_DATA_ACTIONS_CAPABILITY);
      expect(message).toContain("root.onTap[0].path");
      expect(message).toContain("Nothing was shown");
      expect(message).toContain(fix);
    },
  );
});

describe("applyPrototypeDataWrite", () => {
  const data = { cart: [{ sku: "a" }, { sku: "b" }], profile: { name: "Ada" } };
  const ok = (result: ReturnType<typeof applyPrototypeDataWrite>) => {
    if (!result.success) {
      throw new Error(JSON.stringify(result.error));
    }
    return result.data;
  };
  const code = (result: ReturnType<typeof applyPrototypeDataWrite>) =>
    result.success ? undefined : result.error.code;

  test("set creates or replaces an object member and replaces an array element", () => {
    expect(
      ok(applyPrototypeDataWrite(data, { op: "set", path: "/data/profile/age", value: 3 })),
    ).toEqual({ ...data, profile: { name: "Ada", age: 3 } });
    expect(
      ok(applyPrototypeDataWrite(data, { op: "set", path: "/data/profile/name", value: "G" })),
    ).toEqual({ ...data, profile: { name: "G" } });
    expect(
      ok(applyPrototypeDataWrite(data, { op: "set", path: "/data/cart/1", value: "x" })),
    ).toEqual({ ...data, cart: [{ sku: "a" }, "x"] });
    expect(
      ok(applyPrototypeDataWrite(undefined, { op: "set", path: "/data/a", value: 1 })),
    ).toEqual({ a: 1 });
  });
  test("append pushes onto an existing array", () => {
    expect(
      ok(applyPrototypeDataWrite(data, { op: "append", path: "/data/cart", value: { sku: "c" } }))
        .cart,
    ).toEqual([{ sku: "a" }, { sku: "b" }, { sku: "c" }]);
  });
  test("remove deletes a member or shifts later elements down", () => {
    expect(ok(applyPrototypeDataWrite(data, { op: "remove", path: "/data/cart/0" })).cart).toEqual([
      { sku: "b" },
    ]);
    expect(ok(applyPrototypeDataWrite(data, { op: "remove", path: "/data/profile/name" }))).toEqual(
      {
        ...data,
        profile: {},
      },
    );
  });
  test("it never mutates its input", () => {
    const before = structuredClone(data);
    applyPrototypeDataWrite(data, { op: "append", path: "/data/cart", value: 1 });
    applyPrototypeDataWrite(data, { op: "remove", path: "/data/cart/0" });
    expect(data).toEqual(before);
  });
  test("typed errors", () => {
    const cases: [Parameters<typeof applyPrototypeDataWrite>[1], string][] = [
      [{ op: "set", path: "/data", value: 1 }, "invalid_path"],
      [{ op: "set", path: "/state/a", value: 1 }, "invalid_path"],
      [{ op: "remove", path: "/data/a~2" }, "invalid_path"],
      [{ op: "set", path: "/data/a", value: undefined }, "invalid_value"],
      [{ op: "set", path: "/data/a", value: null }, "invalid_value"],
      [{ op: "set", path: "/data/missing/child", value: 1 }, "not_found"],
      [{ op: "set", path: "/data/cart/5", value: 1 }, "not_found"],
      [{ op: "set", path: "/data/cart/name", value: 1 }, "not_found"],
      [{ op: "set", path: "/data/profile/name/deep", value: 1 }, "not_found"],
      [{ op: "append", path: "/data/missing", value: 1 }, "not_found"],
      [{ op: "append", path: "/data/profile", value: 1 }, "not_array"],
      [{ op: "append", path: "/data/profile/name", value: 1 }, "not_array"],
      [{ op: "remove", path: "/data/missing" }, "not_found"],
      [{ op: "remove", path: "/data/cart/2" }, "not_found"],
    ];
    for (const [write, expected] of cases) {
      expect(code(applyPrototypeDataWrite(data, write))).toBe(expected);
    }
  });
  test("a write that leaves data over the size limit changes nothing", () => {
    const limit = contract.limits.MAX_PROTOTYPE_DATA_WRITE_BYTES;
    const nearly = { big: "x".repeat(limit - 64) };
    expect(
      code(applyPrototypeDataWrite(nearly, { op: "set", path: "/data/small", value: "y" })),
    ).toBe(undefined);
    expect(
      code(
        applyPrototypeDataWrite(nearly, { op: "set", path: "/data/more", value: "y".repeat(256) }),
      ),
    ).toBe("limit_exceeded");
  });
  test("a write that leaves data over the array or depth limit is refused", () => {
    const full = {
      rows: Array.from({ length: contract.limits.MAX_PROTOTYPE_DATA_ARRAY_ITEMS }, () => 1),
    };
    expect(
      code(applyPrototypeDataWrite(full, { op: "append", path: "/data/rows", value: 1 })),
    ).toBe("limit_exceeded");
    const deep = { a: { b: { c: { d: { e: { f: {} } } } } } };
    expect(
      code(
        applyPrototypeDataWrite(deep, {
          op: "set",
          path: "/data/a/b/c/d/e/f/g",
          value: { h: { i: 1 } },
        }),
      ),
    ).toBe("limit_exceeded");
  });
  test("a __proto__ member is data, not a prototype", () => {
    const written = ok(
      applyPrototypeDataWrite({}, { op: "set", path: "/data/__proto__", value: { x: 1 } }),
    );
    expect(Object.getPrototypeOf(written)).toBe(Object.prototype);
    expect(Object.hasOwn(written, "__proto__")).toBe(true);
  });
});

describe("resolvePrototypeDataWriteValue", () => {
  const inputs = { state: { picked: "apple" }, data: { profile: { name: "Ada" } } };
  test("resolves literal, state and data bindings", () => {
    expect(resolvePrototypeDataWriteValue({ value: [1] }, inputs)).toEqual({
      success: true,
      value: [1],
    });
    expect(resolvePrototypeDataWriteValue({ state: "picked" }, inputs)).toEqual({
      success: true,
      value: "apple",
    });
    expect(resolvePrototypeDataWriteValue({ data: "/profile/name" }, inputs)).toEqual({
      success: true,
      value: "Ada",
    });
  });
  test("a missing source is a typed error", () => {
    expect(resolvePrototypeDataWriteValue({ state: "nope" }, inputs)).toMatchObject({
      success: false,
      error: { code: "invalid_value" },
    });
    expect(resolvePrototypeDataWriteValue({ data: "/nope" }, inputs)).toMatchObject({
      success: false,
      error: { code: "not_found" },
    });
  });
});
