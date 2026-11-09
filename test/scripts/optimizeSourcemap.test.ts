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
  });

  test("strip nulls one entry per source and preserves every other field without mutating input", () => {
    const before = JSON.stringify(original);
    const expected = { ...original, sourcesContent: [null, null, null] };
    for (const includeDependencySources of [true, false]) {
      const { map, trimmedCount } = optimizeSourceMap(original, {
        stripSources: true,
        includeDependencySources,
      });
      expect(JSON.stringify(map)).toBe(JSON.stringify(expected));
      expect(trimmedCount).toBe(3);
    }
    expect(JSON.stringify(original)).toBe(before);
  });

  test("strip always yields an array as long as sources (Bun rejects anything else)", () => {
    for (const sourcesContent of [undefined, null, "source text", [], ["only one"]]) {
      const { map, trimmedCount } = optimizeSourceMap(
        { ...original, sourcesContent },
        { stripSources: true },
      );
      expect(map.sourcesContent).toEqual([null, null, null]);
      expect(trimmedCount).toBe(
        sourcesContent === "source text" ? 0 : (sourcesContent?.length ?? 0),
      );
    }
    const noSources = { mappings: "AAAA" };
    expect(optimizeSourceMap(noSources, { stripSources: true }).map).toBe(noSources);
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
  const chunk = "/dist/src/chunk-ab12cd34.js.map";
  const nestedChunkLike = "/dist/src/utils/chunk-ab12cd34.js.map";
  const emitted = ["/dist/src/index.js", index, chunk, worker, nestedChunkLike];

  test("default trims only index.js.map, leaving chunk and worker maps untouched", () => {
    expect(selectSourceMaps(emitted, index)).toEqual([{ path: index, options: {} }]);
    const options = { includeDependencySources: true };
    expect(selectSourceMaps(emitted, index, options)).toEqual([{ path: index, options }]);
  });

  test("strip selects every emitted map, with the same options", () => {
    const options = { stripSources: shouldStripSources({}) };
    expect(selectSourceMaps(emitted, index, options)).toEqual(
      [index, chunk, worker, nestedChunkLike].map((path) => ({ path, options })),
    );
  });

  test("opt-out selects only index.js.map", () => {
    const options = { stripSources: shouldStripSources({ [STRIP_SOURCES_ENV]: "false" }) };
    expect(selectSourceMaps(emitted, index, options)).toEqual([{ path: index, options }]);
  });

  test("Windows separators select the index map exactly and chunk maps when stripping", () => {
    const winIndex = "C:\\a\\dist\\src\\index.js.map";
    const winChunk = "C:\\a\\dist\\src\\chunk-ab12cd34.js.map";
    expect(selectSourceMaps([winIndex, winChunk], winIndex)).toEqual([
      { path: winIndex, options: {} },
    ]);
    const options = { stripSources: true };
    expect(selectSourceMaps([winIndex, winChunk], winIndex, options)).toEqual([
      { path: winIndex, options },
      { path: winChunk, options },
    ]);
  });
});

describe("split bundle sourcemaps (#17706)", () => {
  const dir = "/dist/src";
  const indexMap: SourceMap = {
    version: 3,
    sources: ["../../src/index.ts", "../../node_modules/zod/index.js"],
    sourcesContent: ["own source", "zod source"],
    mappings: "AAAA",
  };
  // A dependency chunk: the worker's adm-zip split into a sibling chunk-*.js.
  const admZipChunkMap: SourceMap = {
    version: 3,
    sources: [
      "../../node_modules/adm-zip/adm-zip.js",
      "../../node_modules/adm-zip/zipFile.js",
      "../../src/utils/workers/iosBundleExtractWorker.ts",
    ],
    sourcesContent: ["adm-zip source", "zipFile source", "worker source"],
    mappings: "AAAA;AACA",
  };
  const fixture: Record<string, SourceMap> = {
    [`${dir}/index.js.map`]: indexMap,
    [`${dir}/chunk-0a1b2c3d.js.map`]: admZipChunkMap,
  };
  const emitted = [`${dir}/index.js`, `${dir}/chunk-0a1b2c3d.js`, ...Object.keys(fixture)];

  function build(env: Record<string, string>): Record<string, SourceMap> {
    const output = { ...fixture };
    const options = { stripSources: shouldStripSources(env) };
    for (const { path, options: mapOptions } of selectSourceMaps(
      emitted,
      `${dir}/index.js.map`,
      options,
    )) {
      output[path] = optimizeSourceMap(fixture[path], mapOptions).map;
    }
    return output;
  }

  test("opt-out keeps every source of the dependency chunk map", () => {
    const output = build({ [STRIP_SOURCES_ENV]: "false" });
    expect(output[`${dir}/chunk-0a1b2c3d.js.map`]).toEqual(admZipChunkMap);
    expect(output[`${dir}/index.js.map`].sourcesContent).toEqual(["own source", null]);
  });

  test("default strip still nulls every map's sourcesContent", () => {
    const output = build({});
    expect(output[`${dir}/chunk-0a1b2c3d.js.map`]).toEqual({
      ...admZipChunkMap,
      sourcesContent: [null, null, null],
    });
    expect(output[`${dir}/index.js.map`]).toEqual({ ...indexMap, sourcesContent: [null, null] });
  });
});
