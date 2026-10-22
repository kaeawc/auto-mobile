import { guardDirectoryEntries } from "./astGuard";

import path from "node:path";

export function sourceFiles(directory: string): string[] {
  return guardDirectoryEntries(directory).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)
        ? [file]
        : [];
  });
}

export function findOffenseLines(source: string): number[] {
  if (!source.includes(".automobile")) {
    return [];
  }

  return source
    .split(/\r?\n/)
    .flatMap((line, index) => (/(["'])\.automobile\1/.test(line) ? [index + 1] : []));
}
