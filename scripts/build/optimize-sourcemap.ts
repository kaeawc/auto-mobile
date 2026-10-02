export const STRIP_SOURCES_ENV = "AUTOMOBILE_SOURCEMAP_STRIP_SOURCES";

export interface SourceMap {
  sources: string[];
  sourcesContent?: unknown;
  [key: string]: unknown;
}

export interface SourceMapOptions {
  stripSources?: boolean;
  includeDependencySources?: boolean;
}

/** Main historically rewrites only index.js.map; stripping applies to every emitted map. */
export function selectSourceMaps(
  emittedPaths: readonly string[],
  indexMapPath: string,
  options: SourceMapOptions = {},
): { path: string; options: SourceMapOptions }[] {
  return emittedPaths
    .filter((path) => path.endsWith(".map") && (options.stripSources || path === indexMapPath))
    .map((path) => ({ path, options }));
}

/** Preserve main's dependency-only trimming unless all source text is explicitly stripped. */
export function optimizeSourceMap(
  map: SourceMap,
  options: SourceMapOptions = {},
): { map: SourceMap; trimmedCount: number } {
  if (options.stripSources) {
    if (!Object.hasOwn(map, "sourcesContent")) {
      return { map, trimmedCount: 0 };
    }
    const optimized = { ...map };
    delete optimized.sourcesContent;
    const trimmedCount = Array.isArray(map.sourcesContent)
      ? map.sourcesContent.filter((content) => Boolean(content)).length
      : 0;
    return { map: optimized, trimmedCount };
  }

  if (
    options.includeDependencySources ||
    !Array.isArray(map.sources) ||
    !Array.isArray(map.sourcesContent)
  ) {
    return { map, trimmedCount: 0 };
  }

  let trimmedCount = 0;
  const sourcesContent = map.sourcesContent.map((content: unknown, index: number) => {
    const source = String(map.sources[index] ?? "");
    if (source.includes("node_modules") || source.includes("__bun")) {
      if (content) {
        trimmedCount += 1;
      }
      return null;
    }
    return content;
  });
  return { map: { ...map, sourcesContent }, trimmedCount };
}
