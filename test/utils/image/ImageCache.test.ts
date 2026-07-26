import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { ImageCache } from "../../../src/utils/image/ImageCache";

// ImageCache is a process-wide singleton. Restoring the default max size and
// clearing after every test prevents the small test max sizes from poisoning
// any other suite that shares this bun process.
const DEFAULT_MAX_SIZE = 50 * 1024 * 1024;

describe("ImageCache", () => {
  let cache: ImageCache;

  beforeEach(() => {
    cache = ImageCache.getInstance();
    cache.clear();
    cache.setMaxSize(DEFAULT_MAX_SIZE);
  });

  afterEach(() => {
    cache.clear();
    cache.setMaxSize(DEFAULT_MAX_SIZE);
  });

  test("returns a stored buffer by key", () => {
    const buffer = Buffer.from("cached-pixels");
    cache.set("a", buffer);
    expect(cache.get("a")).toBe(buffer);
  });

  test("returns undefined for a key that was never stored", () => {
    expect(cache.get("missing")).toBeUndefined();
  });

  test("refuses to cache a buffer larger than the max size", () => {
    cache.setMaxSize(100);
    cache.set("big", Buffer.alloc(200));
    expect(cache.get("big")).toBeUndefined();
  });

  test("evicts the least-recently-used entry, honoring get() as a recency bump", () => {
    cache.setMaxSize(250);
    cache.set("a", Buffer.alloc(100));
    cache.set("b", Buffer.alloc(100));

    // Touch "a" so "b" becomes the least-recently-used entry.
    expect(cache.get("a")).toBeDefined();

    cache.set("c", Buffer.alloc(100)); // over capacity -> evict one entry

    expect(cache.get("b")).toBeUndefined();
    expect(cache.get("a")).toBeDefined();
    expect(cache.get("c")).toBeDefined();
  });

  test("overwriting a key does not double-count its size and prematurely evict a live entry", () => {
    cache.setMaxSize(250);
    cache.set("a", Buffer.alloc(100));
    // Overwrite "a" with a same-size buffer. If currentSize kept the old 100
    // bytes, it would inflate to 200 and evict "a" when "b" is added.
    cache.set("a", Buffer.alloc(100));
    cache.set("b", Buffer.alloc(100));

    expect(cache.get("a")).toBeDefined();
    expect(cache.get("b")).toBeDefined();
  });

  test("clear removes all entries", () => {
    cache.set("a", Buffer.from("x"));
    cache.clear();
    expect(cache.get("a")).toBeUndefined();
  });
});
