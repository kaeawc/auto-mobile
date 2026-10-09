export const STRIP_SOURCES_ENV = "AUTOMOBILE_SOURCEMAP_STRIP_SOURCES";

export function shouldStripSources(env: Record<string, string | undefined>): boolean {
  const value = env[STRIP_SOURCES_ENV]?.trim().toLowerCase();
  return value !== "0" && value !== "false";
}

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

/** Preserve dependency-only trimming when stripping all source text is disabled. */
export function optimizeSourceMap(
  map: SourceMap,
  options: SourceMapOptions = {},
): { map: SourceMap; trimmedCount: number } {
  if (options.stripSources) {
    // Bun's decoder rejects a map whose sourcesContent is absent or whose length
    // differs from sources (InvalidSourceMap, #10849), so keep one null per source.
    if (!Array.isArray(map.sources)) {
      return { map, trimmedCount: 0 };
    }
    const trimmedCount = Array.isArray(map.sourcesContent)
      ? map.sourcesContent.filter((content) => Boolean(content)).length
      : 0;
    return { map: { ...map, sourcesContent: map.sources.map(() => null) }, trimmedCount };
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
