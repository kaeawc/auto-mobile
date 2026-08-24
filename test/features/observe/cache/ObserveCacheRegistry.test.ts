import { afterEach, describe, expect, test } from "bun:test";
import {
  getObserveCacheStore,
  resetObserveCacheStore,
  setObserveCacheStore,
} from "../../../../src/features/observe/cache/ObserveCacheRegistry";
import { FakeObserveCacheStore } from "../../../fakes/FakeObserveCacheStore";

describe("ObserveCacheRegistry", function () {
  afterEach(function () {
    resetObserveCacheStore();
  });

  test("returns a default FileSystemObserveCacheStore initially", function () {
    const store = getObserveCacheStore();
    expect(store).toBeDefined();
    // Default store implements the same interface; constructor name check is sufficient.
    expect(store.constructor.name).toBe("FileSystemObserveCacheStore");
  });

  test("setObserveCacheStore swaps the singleton instance", function () {
    const fake = new FakeObserveCacheStore();
    setObserveCacheStore(fake);
    expect(getObserveCacheStore()).toBe(fake);
  });

  test("resetObserveCacheStore restores a default file-system store", function () {
    const fake = new FakeObserveCacheStore();
    setObserveCacheStore(fake);
    expect(getObserveCacheStore()).toBe(fake);
    resetObserveCacheStore();
    expect(getObserveCacheStore()).not.toBe(fake);
    expect(getObserveCacheStore().constructor.name).toBe("FileSystemObserveCacheStore");
  });

  test("swapped store is observable via the registry getter", async function () {
    const fake = new FakeObserveCacheStore();
    setObserveCacheStore(fake);
    await getObserveCacheStore().put("device-x", {
      updatedAt: "now",
      screenSize: { width: 1, height: 2 },
      systemInsets: { top: 0, right: 0, bottom: 0, left: 0 },
    });
    expect(fake.getEntryCount()).toBe(1);
    expect(getObserveCacheStore().getRecentInMemoryForDevice("device-x")).toBeDefined();
  });
});
