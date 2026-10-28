import { describe, expect, test } from "bun:test";
import { ActionableError } from "../../../src/models/ActionableError";
import { PrototypeMockBackendRegistry } from "../../../src/features/prototype/PrototypeMockBackendRegistry";
import {
  MAX_MOCK_BACKENDS,
  MAX_MOCK_BACKEND_BYTES,
} from "../../../src/features/prototype/prototypeMockSchema";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { SeededRandom } from "../../fakes/SeededRandom";

const registry = (createRandom?: (seed: number | undefined) => SeededRandom) =>
  new PrototypeMockBackendRegistry({
    ids: new FakeIdGenerator(),
    timer: { sleep: async () => {} },
    createRandom,
  });

const get = (r: PrototypeMockBackendRegistry, id: string, path: string) =>
  r.get(id)!.answer({ method: "GET", path, query: {}, body: undefined });

describe("PrototypeMockBackendRegistry", () => {
  test("define makes a backend answer, and redefining replaces it and resets its state", async () => {
    const r = registry();
    r.define("shop", { collections: { items: [{ id: 1 }] } });
    await r.get("shop")!.answer({ method: "POST", path: "/items", query: {}, body: { id: 2 } });
    expect((await get(r, "shop", "/items")).body).toEqual([{ id: 1 }, { id: 2 }]);
    r.define("shop", { collections: { items: [{ id: 1 }] } });
    expect((await get(r, "shop", "/items")).body).toEqual([{ id: 1 }]);
    expect(r.ids()).toEqual(["shop"]);
  });

  test("clear and clearAll remove backends", () => {
    const r = registry();
    r.define("a", {});
    r.define("b", {});
    expect(r.clear("a")).toBe(true);
    expect(r.clear("a")).toBe(false);
    r.clearAll();
    expect(r.ids()).toEqual([]);
  });

  test("rejects bad ids", () => {
    const r = registry();
    for (const id of ["", "A", "-x", "a.b", "a_b", "x".repeat(32)]) {
      expect(() => r.define(id, {})).toThrow(ActionableError);
    }
    expect(() => r.define("x".repeat(31), {})).not.toThrow();
  });

  test("caps the number of backends but still allows replacing one at the cap", () => {
    const r = registry();
    for (let i = 0; i < MAX_MOCK_BACKENDS; i++) {
      r.define(`b${i}`, {});
    }
    expect(() => r.define("extra", {})).toThrow(/At most 16/);
    expect(() => r.define("b0", { routes: [] })).not.toThrow();
  });

  test("the seed selects the random stream", () => {
    const seeds: (number | undefined)[] = [];
    const r = registry((seed) => {
      seeds.push(seed);
      return new SeededRandom(seed);
    });
    r.define("a", { seed: 9 });
    r.define("b", {});
    expect(seeds).toEqual([9, undefined]);
  });

  test("an invalid definition names the failing path and does not replace the old one", async () => {
    const r = registry();
    r.define("a", { collections: { items: [{ id: 1 }] } });
    expect(() => r.define("a", { collections: { items: [{ id: 1 }, { id: 1 }] } })).toThrow(
      /collections\.items: item ids must be unique/,
    );
    expect((await get(r, "a", "/items")).body).toEqual([{ id: 1 }]);
  });

  test.each<[string, unknown, RegExp]>([
    ["unknown top-level key", { rooms: {} }, /rooms|Unrecognized/],
    ["bad collection name", { collections: { "1x": [] } }, /collection names/],
    [
      "too many collections",
      { collections: Object.fromEntries(Array.from({ length: 17 }, (_, i) => [`c${i}`, []])) },
      /at most 16 collections/,
    ],
    ["non-object item", { collections: { a: [1] } }, /collections\.a\.0/],
    ["boolean id", { collections: { a: [{ id: true }] } }, /id must be a string or a number/],
    [
      "deep item",
      { collections: { a: [{ a: { b: { c: { d: { e: { f: { g: { h: {} } } } } } } } }] } },
      /nest at most 8/,
    ],
    ["bad route path", { routes: [{ method: "GET", path: "feed" }] }, /routes\.0\.path/],
    ["bad route method", { routes: [{ method: "TRACE", path: "/x" }] }, /routes\.0\.method/],
    ["unknown route key", { routes: [{ method: "GET", path: "/x", extra: 1 }] }, /routes\.0/],
    [
      "status below 100",
      { routes: [{ method: "GET", path: "/x", status: 99 }] },
      /routes\.0\.status/,
    ],
    [
      "too many routes",
      { routes: Array.from({ length: 65 }, () => ({ method: "GET", path: "/x" })) },
      /routes/,
    ],
    [
      "fault with neither every nor rate",
      { faults: [{ path: "/x", status: 500 }] },
      /exactly one of every or rate/,
    ],
    [
      "fault with both",
      { faults: [{ path: "/x", status: 500, every: 2, rate: 0.5 }] },
      /exactly one of every or rate/,
    ],
    [
      "fault success status",
      { faults: [{ path: "/x", status: 200, every: 1 }] },
      /faults\.0\.status/,
    ],
    ["zero rate", { faults: [{ path: "/x", status: 500, rate: 0 }] }, /faults\.0\.rate/],
    ["latency min above max", { latencyMs: { min: 5, max: 1 } }, /min cannot exceed max/],
    ["latency over the cap", { latencyMs: { min: 0, max: 10_001 } }, /latencyMs\.max/],
    ["fractional seed", { seed: 1.5 }, /seed/],
    [
      "over the byte budget",
      { collections: { a: [{ t: "x".repeat(MAX_MOCK_BACKEND_BYTES) }] } },
      /holds at most/,
    ],
  ])("rejects %s", (_name, definition, message) => {
    expect(() => registry().define("a", definition)).toThrow(message);
  });
});
