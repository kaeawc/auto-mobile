import { describe, expect, test } from "bun:test";
import {
  optimizeSourceMap,
  selectSourceMaps,
  shouldStripSources,
  STRIP_SOURCES_ENV,
  type SourceMap,
} from "../../scripts/build/optimize-sourcemap";

const original: SourceMap = {
  version: 3,
  sources: ["../../../src/index.ts", "../node_modules/pkg/index.ts", "../__bun/pkg.ts"],
  sourcesContent: ["own source", "dependency source", "bun source"],
  mappings: "AAAA;AACA,CAAC",
  names: ["main"],
  debugId: "unchanged-debug-id",
  file: "index.js",
};

describe("shouldStripSources", () => {
  for (const value of [undefined, "true", "1", "", "unexpected"]) {
    test(`strips sources for ${JSON.stringify(value)}`, () => {
      expect(shouldStripSources(value === undefined ? {} : { [STRIP_SOURCES_ENV]: value })).toBe(
        true,
      );
    });
  }

  for (const value of ["false", "0", " FALSE ", " 0 "]) {
    test(`keeps embedded sources for ${JSON.stringify(value)}`, () => {
      expect(shouldStripSources({ [STRIP_SOURCES_ENV]: value })).toBe(false);
    });
  }
});

describe("optimizeSourceMap", () => {
  test("default keeps repo sources and every other field, nulling only dependency entries", () => {
    const before = JSON.stringify(original);
    const { map, trimmedCount } = optimizeSourceMap(original, {
      stripSources: shouldStripSources({ [STRIP_SOURCES_ENV]: "false" }),
    });
    expect(JSON.stringify(map)).toBe(
      JSON.stringify({ ...original, sourcesContent: ["own source", null, null] }),
    );
    expect(trimmedCount).toBe(2);
    expect(JSON.stringify(original)).toBe(before);
  });

  test("includeDependencySources leaves the map untouched", () => {
    const result = optimizeSourceMap(original, { includeDependencySources: true });
    expect(result.map).toBe(original);
    expect(result).toEqual({ map: original, trimmedCount: 0 });
  });

  test("non-array or absent sourcesContent is a no-op by default", () => {
    for (const sourcesContent of [undefined, null, "source text", { text: "source text" }]) {
      const map: SourceMap = { ...original, sourcesContent };
      const result = optimizeSourceMap(map);
      expect(result.map).toBe(map);
      expect(result.trimmedCount).toBe(0);
    }
    const map: SourceMap = { sources: ["index.ts"], mappings: "AAAA" };
    expect(optimizeSourceMap(map).map).toBe(map);
    expect(optimizeSourceMap(map, { stripSources: true }).map).toBe(map);
  });

  test("strip deletes the key and preserves every other field without mutating input", () => {
    const before = JSON.stringify(original);
    const expected = { ...original };
    delete expected.sourcesContent;
    for (const includeDependencySources of [true, false]) {
      const { map, trimmedCount } = optimizeSourceMap(original, {
        stripSources: true,
        includeDependencySources,
      });
      expect(Object.hasOwn(map, "sourcesContent")).toBe(false);
      expect(JSON.stringify(map)).toBe(JSON.stringify(expected));
      expect(trimmedCount).toBe(3);
    }
    expect(JSON.stringify(original)).toBe(before);
    expect(
      Object.hasOwn(
        optimizeSourceMap({ ...original, sourcesContent: null }, { stripSources: true }).map,
        "sourcesContent",
      ),
    ).toBe(false);
  });

  test("trimmed counts only populated content and repeated optimization is idempotent", () => {
    const map = { ...original, sourcesContent: ["own source", null, ""] };
    const retained = optimizeSourceMap(map);
    expect(retained.trimmedCount).toBe(0);
    expect(optimizeSourceMap(retained.map)).toEqual(retained);
    const removed = optimizeSourceMap(map, { stripSources: true });
    expect(removed.trimmedCount).toBe(1);
    expect(optimizeSourceMap(removed.map, { stripSources: true })).toEqual({
      map: removed.map,
      trimmedCount: 0,
    });
  });
});

describe("selectSourceMaps", () => {
  const index = "/dist/src/index.js.map";
  const worker = "/dist/src/utils/workers/iosBundleExtractWorker.js.map";
  const emitted = ["/dist/src/index.js", index, worker];

  test("default selects only index.js.map and skips the worker map entirely", () => {
    expect(selectSourceMaps(emitted, index)).toEqual([{ path: index, options: {} }]);
    const options = { includeDependencySources: true };
    expect(selectSourceMaps(emitted, index, options)).toEqual([{ path: index, options }]);
  });

  test("strip selects every emitted map, with the same options", () => {
    const options = { stripSources: shouldStripSources({}) };
    expect(selectSourceMaps(emitted, index, options)).toEqual([
      { path: index, options },
      { path: worker, options },
    ]);
  });

  test("opt-out selects only index.js.map", () => {
    const options = { stripSources: shouldStripSources({ [STRIP_SOURCES_ENV]: "false" }) };
    expect(selectSourceMaps(emitted, index, options)).toEqual([{ path: index, options }]);
  });
});
