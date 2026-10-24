import { describe, expect, test } from "bun:test";
import { createEpochReadCache } from "./fixtures/epochReadCache";

class CountingStore {
  reads = 0;
  value = { nested: { n: 1 } };
  async get(id: string) {
    this.reads++;
    return { id, ...this.value };
  }
  async set(n: number) {
    this.value = { nested: { n } };
  }
}

describe("createEpochReadCache", () => {
  test("serves repeated reads without re-reading until a non-read call", async () => {
    const store = new CountingStore();
    const cached = createEpochReadCache().wrap(store, ["get"]);
    expect(await cached.get("a")).toEqual({ id: "a", nested: { n: 1 } });
    expect(await cached.get("a")).toEqual({ id: "a", nested: { n: 1 } });
    expect(store.reads).toBe(1);
    await cached.set(2);
    expect(await cached.get("a")).toEqual({ id: "a", nested: { n: 2 } });
    expect(store.reads).toBe(2);
  });

  test("keys reads by arguments", async () => {
    const store = new CountingStore();
    const cached = createEpochReadCache().wrap(store, ["get"]);
    await cached.get("a");
    await cached.get("b");
    expect(store.reads).toBe(2);
  });

  test("a call on any wrapped double invalidates every cache", async () => {
    const cache = createEpochReadCache();
    const first = cache.wrap(new CountingStore(), ["get"]);
    const second = cache.wrap(new CountingStore(), ["get"]);
    await first.get("a");
    await second.set(5);
    await first.get("a");
    expect(first.reads).toBe(2);
  });

  test("cached values are frozen so a mutating caller fails loudly", async () => {
    const cached = createEpochReadCache().wrap(new CountingStore(), ["get"]);
    await cached.get("a");
    const hit = await cached.get("a");
    expect(() => {
      hit.nested.n = 9;
    }).toThrow();
  });
});
