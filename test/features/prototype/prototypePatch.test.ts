import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import {
  applyPrototypePatch,
  MAX_PROTOTYPE_PATCH_OPS,
  prototypePatchTouchesState,
} from "../../../src/features/prototype/prototypePatch";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

interface Fixture {
  name: string;
  spec: Record<string, unknown>;
  ops: unknown;
  stateTests?: "evaluate" | "skip";
  expected?: Record<string, unknown>;
  stage?: "apply" | "validate";
  expectedPath?: string;
  expectedMessage?: string;
}

const directory = join(import.meta.dir, "../../fixtures/prototype-spec/patch");
const fixtures: Fixture[] = readdirSync(directory)
  .filter((name) => name.endsWith(".json"))
  .sort()
  .map((name) => ({ ...JSON.parse(readFileSync(join(directory, name), "utf8")), name }));
const base = {
  id: "patch",
  window: { placement: { type: "fullscreen" }, opacity: 1 },
  root: { type: "column", id: "root", children: [{ type: "text", id: "label", text: "hello" }] },
  data: {},
};

describe("shared prototype patch fixtures", () => {
  test("fixture directory is populated", () => {
    expect(fixtures.length).toBeGreaterThanOrEqual(45);
  });
  test.each(fixtures)("$name", (fixture) => {
    const pristineSpec = structuredClone(fixture.spec);
    const pristineOps = structuredClone(fixture.ops);
    expect(validatePrototypeSpec(fixture.spec).success).toBe(true);
    const result = applyPrototypePatch(fixture.spec, fixture.ops, {
      stateTests: fixture.stateTests,
    });
    const expectedError = { path: fixture.expectedPath, message: fixture.expectedMessage };
    if (fixture.stage === "apply") {
      expect<unknown>(result).toEqual({ success: false, error: expectedError });
    } else {
      expect(result.success).toBe(true);
      if (!result.success) {
        throw new Error(`Unexpected apply error in ${fixture.name}`);
      }
      if (fixture.stage === "validate") {
        const validated = validatePrototypeSpec(result.spec);
        expect(validated.success).toBe(false);
        if (validated.success) {
          throw new Error(`Unexpected validation success in ${fixture.name}`);
        }
        expect<unknown>(validated.error).toEqual(expectedError);
      } else {
        expect(validatePrototypeSpec(fixture.expected).success).toBe(true);
        expect<unknown>(result.spec).toEqual(fixture.expected);
      }
    }
    expect(fixture.spec).toEqual(pristineSpec);
    expect(fixture.ops).toEqual(pristineOps);
  });
});

describe("prototype patch direct contracts", () => {
  test("13 replacement ops with an 8000-deep child chain report rule 23 without throwing", () => {
    let leafTypeReads = 0;
    let node: Record<string, unknown> = {
      get type() {
        leafTypeReads++;
        return "use";
      },
      component: "deep",
    };
    for (let i = 0; i < 8000; i++) {
      node = { type: "card", child: node };
    }
    node.id = "label";
    const op = { op: "replaceNode", id: "label", node };
    const ops = Array(13).fill(op);
    let laterOpReads = 0;
    for (let i = 1; i < ops.length; i++) {
      Object.defineProperty(ops, i, {
        get() {
          laterOpReads++;
          return op;
        },
      });
    }
    const result = applyPrototypePatch(base, ops);
    // Count reads of ops[1..12] and the deep leaf's type to detect later-op validation and leaf re-walks.
    expect(laterOpReads).toBe(0);
    expect(leafTypeReads).toBe(1);
    expect(result).toEqual({
      success: false,
      error: {
        path: `ops[0].node${".child".repeat(8000)}.type`,
        message: "Components are not expanded in a patch: inline the node or use show",
      },
    });
  });
  test("pollution-sensitive names are own members", () => {
    const prototype = Object.getOwnPropertyDescriptors(Object.prototype);
    const value = { polluted: true };
    const result = applyPrototypePatch(base, [
      { op: "add", path: "/data/__proto__", value },
      { op: "add", path: "/data/constructor", value },
      { op: "add", path: "/data/toString", value },
    ]);
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected success");
    }
    const data = result.spec.data as Record<string, unknown>;
    for (const key of ["__proto__", "constructor", "toString"]) {
      expect(Object.hasOwn(data, key)).toBe(true);
      expect(data[key]).toEqual(value);
    }
    expect(Object.getPrototypeOf(data)).toBe(Object.prototype);
    expect(Object.getOwnPropertyDescriptors(Object.prototype)).toEqual(prototype);
    expect(Reflect.get({}, "polluted")).toBeUndefined();
  });
  test("the contract allows exactly 64 ops", () => {
    expect(MAX_PROTOTYPE_PATCH_OPS).toBe(64);
    const ops = Array.from({ length: 64 }, (_, i) => ({
      op: "add",
      path: `/data/k${i}`,
      value: i,
    }));
    const result = applyPrototypePatch(base, ops);
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected success");
    }
    expect(Object.keys(result.spec.data as object)).toHaveLength(64);
    expect(applyPrototypePatch(base, [...ops, ops[0]])).toEqual({
      success: false,
      error: { path: "ops", message: "Array length out of range" },
    });
  });
  test.each(["/state/a", "/state"])("touches state: %s", (path) => {
    expect(prototypePatchTouchesState([{ path }])).toBe(true);
  });
  test.each(
    [
      undefined,
      null,
      {},
      "state",
      [null, 1, [], {}, { path: 1 }],
      [{ path: "/data/state" }],
      [{ path: "/stateful" }],
    ].map((ops, index) => ({ ops, index })),
  )("ignores unrelated or malformed paths: $index", ({ ops }) => {
    expect(prototypePatchTouchesState(ops)).toBe(false);
  });
  test("the returned graph shares no objects with either input", () => {
    const spec = structuredClone(base);
    const value = { nested: [1] };
    const node = { type: "card", id: "label", child: { type: "text", text: "new" } };
    const ops = [
      { op: "add", path: "/data/a", value },
      { op: "replaceNode", id: "label", node },
    ];
    const result = applyPrototypePatch(spec, ops);
    expect(result.success).toBe(true);
    if (!result.success) {
      throw new Error("Expected success");
    }
    const inputObjects = new Set<object>();
    collectObjects(spec, inputObjects);
    collectObjects(ops, inputObjects);
    const outputObjects = new Set<object>();
    collectObjects(result.spec, outputObjects);
    for (const object of outputObjects) {
      expect(inputObjects.has(object)).toBe(false);
    }
    const data = result.spec.data as { a: { nested: number[] } };
    data.a.nested.push(2);
    const root = result.spec.root as { children: { child: { text: string } }[] };
    root.children[0].child.text = "mutated";
    expect(spec).toEqual(base);
    expect(value).toEqual({ nested: [1] });
    expect(node.child.text).toBe("new");
  });
  test.each([null, [], "spec", 1].map((spec) => ({ spec })))(
    "rejects non-object spec first: $spec",
    ({ spec }) => {
      expect(applyPrototypePatch(spec, null)).toEqual({
        success: false,
        error: { path: "$", message: "Expected object" },
      });
    },
  );
  test("unknown names use Unicode code-point order", () => {
    expect(
      applyPrototypePatch(base, [{ op: "remove", path: "/data", "\u{10000}": 1, "\uE000": 1 }]),
    ).toEqual({
      success: false,
      error: { path: "ops[0].\uE000", message: "Unknown property" },
    });
  });
  test.each(["/data/" + "a".repeat(256), "/state/" + "a".repeat(256)])(
    "pointer length is checked on the relative suffix: %s",
    (path) => {
      expect(applyPrototypePatch(base, [{ op: "add", path, value: 1 }])).toEqual({
        success: false,
        error: { path: "ops[0].path", message: "Patch paths start with /data or /state" },
      });
    },
  );
  test("state skip still enforces scalar and existence checks", () => {
    expect(
      applyPrototypePatch(base, [{ op: "test", path: "/state/a", value: {} }], {
        stateTests: "skip",
      }),
    ).toEqual({
      success: false,
      error: { path: "ops[0].value", message: "Invalid scalar value" },
    });
    expect(
      applyPrototypePatch(base, [{ op: "test", path: "/state/a", value: false }], {
        stateTests: "skip",
      }),
    ).toEqual({
      success: false,
      error: { path: "ops[0].path", message: "Path does not exist" },
    });
  });
});

function collectObjects(value: unknown, objects: Set<object>): void {
  if (typeof value !== "object" || value === null) {
    return;
  }
  objects.add(value);
  for (const child of Object.values(value)) {
    collectObjects(child, objects);
  }
}
