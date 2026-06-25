import { beforeEach, describe, expect, test } from "bun:test";
import { loadSharp, resetSharpForTesting } from "../../../src/utils/image/loadSharp";

function makeFakeSharpModule() {
  const cacheCalls: unknown[] = [];
  const concurrencyCalls: number[] = [];
  const factory: any = () => ({});
  factory.cache = (opts: unknown) => {
    cacheCalls.push(opts);
    return factory;
  };
  factory.concurrency = (n: number) => {
    concurrencyCalls.push(n);
    return n;
  };
  return { module: { default: factory }, factory, cacheCalls, concurrencyCalls };
}

describe("loadSharp", () => {
  beforeEach(() => {
    resetSharpForTesting();
  });

  test("memoizes a successful load (importer called once)", async () => {
    const fake = makeFakeSharpModule();
    let calls = 0;
    const importer = async () => {
      calls++;
      return fake.module as any;
    };

    const a = await loadSharp(importer as any);
    const b = await loadSharp(importer as any);

    expect(calls).toBe(1);
    expect(a).toBe(b);
    expect(a).toBe(fake.factory);
  });

  test("applies bounded cache + concurrency exactly once", async () => {
    const fake = makeFakeSharpModule();
    const importer = async () => fake.module as any;

    await loadSharp(importer as any);
    await loadSharp(importer as any);

    expect(fake.cacheCalls).toHaveLength(1);
    expect(fake.concurrencyCalls).toHaveLength(1);
    expect(fake.cacheCalls[0]).toEqual({ memory: 50, items: 50, files: 0 });
    expect(fake.concurrencyCalls[0]).toBeGreaterThanOrEqual(1);
    expect(fake.concurrencyCalls[0]).toBeLessThanOrEqual(4);
  });

  test("memoizes a failed load — a permanent native-binary failure is not re-imported", async () => {
    let calls = 0;
    const importer = async () => {
      calls++;
      throw new Error("native load fail");
    };

    await expect(loadSharp(importer as any)).rejects.toThrow(/native load fail/);
    await expect(loadSharp(importer as any)).rejects.toThrow(/native load fail/);
    // The rejected promise is cached, so we don't re-attempt a permanent failure.
    expect(calls).toBe(1);
  });
});
