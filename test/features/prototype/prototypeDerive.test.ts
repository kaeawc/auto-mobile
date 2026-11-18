import { resolvePrototypeDerived } from "../../../src/features/prototype/prototypeFormat";
import { webRepeatRows } from "../../../src/features/prototype/web/webRepeat";
import { expect, test } from "bun:test";
import fixtureData from "../../fixtures/prototype-spec/derive/collections.json";
import {
  derivePrototypeValues,
  type PrototypeDeriveObserver,
} from "../../../src/features/prototype/prototypeDerive";
import { prototypeDeriveSchema } from "../../../src/features/prototype/prototypeFormatSchema";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";
import { requiredPrototypeCapabilities } from "../../../src/features/prototype/prototypeCapabilityGates";
import { prototypeDeriveUnsupportedMessage } from "../../../src/features/prototype/prototypeFormatCapability";
interface CollectionCase {
  name: string;
  spec: { derive: unknown };
  data: Record<string, unknown>;
  state: Record<string, unknown>;
  expected: Record<string, unknown>;
  changes?: {
    state?: Record<string, unknown>;
    data?: Record<string, unknown>;
    expectRecomputed: string[];
  }[];
}
interface CollectionErrorCase {
  name: string;
  derive: unknown;
  error: { path: string; message: string };
}
const fixtures: (CollectionCase | CollectionErrorCase)[] = fixtureData;
class Counter implements PrototypeDeriveObserver {
  names: string[] = [];
  recomputed(name: string): void {
    this.names.push(name);
  }
}
for (const fixture of fixtures) {
  test(fixture.name, () => {
    if ("error" in fixture) {
      const result = validatePrototypeSpec({
        id: "collections",
        window: { placement: { type: "fullscreen" } },
        derive: fixture.derive,
        root: { type: "text", text: "ok" },
      });
      expect(result).toEqual({ success: false, error: fixture.error });
      return;
    }
    const derive = prototypeDeriveSchema.parse(fixture.spec.derive);
    const counter = new Counter();
    let data = fixture.data;
    let state = fixture.state;
    let values = derivePrototypeValues(derive, data, state, undefined, undefined, counter);
    expect(values).toEqual(fixture.expected);
    expect(
      validatePrototypeSpec({
        id: "collections",
        window: { placement: { type: "fullscreen" } },
        ...fixture.spec,
        data: fixture.data,
        state: fixture.state,
        root: { type: "text", text: "ok" },
      }).success,
    ).toBe(true);
    for (const change of fixture.changes ?? []) {
      counter.names = [];
      state = { ...state, ...change.state };
      data = { ...data, ...change.data };
      const previous = values;
      values = derivePrototypeValues(
        derive,
        data,
        state,
        values,
        {
          stateKeys: new Set(Object.keys(change.state ?? {})),
          dataPointers: new Set(Object.keys(change.data ?? {}).map((key) => "/" + key)),
        },
        counter,
      );
      expect(counter.names).toEqual(change.expectRecomputed);
      for (const name of Object.keys(previous)) {
        if (!counter.names.includes(name)) {
          expect(values[name]).toBe(previous[name]);
        }
      }
    }
  });
}
test("preserves objects, bounds work, formats reductions and gates collections", () => {
  const rows = Array.from({ length: 501 }, (_, id) => ({ id, n: id }));
  const derive = prototypeDeriveSchema.parse({
    results: { collection: { of: { data: "/rows" } } },
    total: {
      collection: { of: { data: "/rows" }, limit: 2 },
      reduce: { op: "sum", field: "n" },
      format: { number: {} },
    },
  });
  const values = derivePrototypeValues(derive, { rows }, {});
  expect(Array.isArray(values.results) && values.results.length).toBe(500);
  expect(Array.isArray(values.results) && values.results[0]).toBe(rows[0]);
  const spec = {
    id: "collections",
    window: { placement: { type: "fullscreen" } },
    data: { rows: rows.slice(0, 2) },
    derive,
    root: {
      type: "column",
      repeat: { items: { derived: "results" }, as: "row", key: "id" },
      children: [{ type: "text", text: "{row.n}" }],
    },
  };
  expect(validatePrototypeSpec(spec).success).toBe(true);
  expect(requiredPrototypeCapabilities(spec)).toContain("prototype_derive_v1");
  expect(prototypeDeriveUnsupportedMessage(["derive.results.collection"], "ios")).toContain(
    "does not advertise prototype_derive_v1",
  );
  expect(prototypeDeriveUnsupportedMessage(["derive.results.collection"], "android")).toContain(
    "Nothing was shown",
  );
  for (const name of ["absent", "total"]) {
    const invalid = {
      ...spec,
      root: { ...spec.root, repeat: { ...spec.root.repeat, items: { derived: name } } },
    };
    const result = validatePrototypeSpec(invalid);
    expect(result.success).toBe(false);
    if (!result.success) {
      expect(result.error.path).toBe("root.repeat.items.derived");
    }
  }
});

test("reductions follow the existing placeholder format path and arrays bind original rows", () => {
  const rows = [{ id: "a", amount: 2.5 }];
  const derive = prototypeDeriveSchema.parse({
    results: { collection: { of: { data: "/rows" } } },
    total: {
      collection: { of: { data: "/rows" } },
      reduce: { op: "sum", field: "amount" },
      format: { number: { minFraction: 2 } },
    },
  });
  const derived = derivePrototypeValues(derive, { rows }, {});
  expect(webRepeatRows({ items: { derived: "results" } }, {}, 10, derived)[0]).toBe(rows[0]);
  expect(
    resolvePrototypeDerived({ derive }, "total", {
      data: { rows },
      env: { locale: "en-US", timeZone: "UTC", nowMs: 0 },
    }),
  ).toBe("2.50");
});
test("collection map stays bounded to 32 entries", () => {
  const entry = { collection: { of: { data: "/rows" } } };
  expect(
    prototypeDeriveSchema.safeParse(
      Object.fromEntries(Array.from({ length: 32 }, (_, index) => ["result" + index, entry])),
    ).success,
  ).toBe(true);
  expect(
    prototypeDeriveSchema.safeParse(
      Object.fromEntries(Array.from({ length: 33 }, (_, index) => ["result" + index, entry])),
    ).success,
  ).toBe(false);
});

test("invalid repeat sources and projected collisions report their authored paths", () => {
  const derive = { results: { collection: { of: { data: "/rows" } } } };
  const root = {
    type: "column",
    repeat: { items: { derived: "results" }, as: "row" },
    children: [{ type: "text", text: "{row.n}" }],
  };
  const base = {
    id: "collections",
    window: { placement: { type: "fullscreen" } },
    data: { rows: [{ n: 1 }] },
    derive,
    root,
  };
  const result = validatePrototypeSpec({
    ...base,
    root: {
      ...root,
      repeat: { ...root.repeat, derive: { n: { of: { item: "n" }, format: { number: {} } } } },
    },
  });
  expect(result).toEqual({
    success: false,
    error: { path: "root.repeat.derive.n", message: "Derived name collides with an item field" },
  });
  const unknownField = validatePrototypeSpec({
    ...base,
    root: { ...root, children: [{ type: "text", text: "{row.missing}" }] },
  });
  expect(unknownField).toEqual({
    success: false,
    error: { path: "root.children[0].text", message: 'Unknown repeat field "missing"' },
  });
});
test("changed ancestor and descendant pointers recompute only dependent entries", () => {
  const derive = prototypeDeriveSchema.parse({
    results: { collection: { of: { data: "/group/rows" } } },
    literal: { of: { value: 2 }, format: { number: {} } },
    scalar: { of: { state: "n" }, format: { number: {} } },
  });
  const counter = new Counter();
  const initial = derivePrototypeValues(derive, { group: { rows: [] } }, { n: 1 });
  for (const pointer of ["/group", "/group/rows/0"]) {
    counter.names = [];
    derivePrototypeValues(
      derive,
      { group: { rows: [] } },
      { n: 1 },
      initial,
      { dataPointers: new Set([pointer]), stateKeys: new Set() },
      counter,
    );
    expect(counter.names).toEqual(["results"]);
  }
});
