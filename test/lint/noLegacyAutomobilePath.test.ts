import { guardDirectoryEntries, readGuardFile } from "./astGuard";
import { describe, expect, test } from "bun:test";

import { readFileSync } from "node:fs";
import path from "node:path";

const SOURCE_DIR = path.join(import.meta.dir, "..", "..", "src");
const LEGACY_COMPONENT = ".automobile";

function sourceFiles(directory: string): string[] {
  return guardDirectoryEntries(directory).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)
        ? [file]
        : [];
  });
}

function findOffenseLines(source: string): number[] {
  if (!source.includes(LEGACY_COMPONENT)) {
    return [];
  }

  return source
    .split(/\r?\n/)
    .flatMap((line, index) => (/(["'])\.automobile\1/.test(line) ? [index + 1] : []));
}

describe("legacy AutoMobile path matcher", () => {
  test("matches only quoted .automobile literals", () => {
    expect(findOffenseLines("const a = \".automobile\";\nconst b = '.automobile';")).toEqual([
      1, 2,
    ]);
    expect(
      findOffenseLines(
        'const a = ".automobile\';\nconst b = \'.automobile";\nconst c = ".automobile-foo";',
      ),
    ).toEqual([]);
  });
});

describe("shared AutoMobile directory path literals", () => {
  // The scan runs inside the test so the per-test timing gate measures it (#14475).
  test("does not use the legacy .automobile path component", () => {
    const offenses = sourceFiles(SOURCE_DIR)
      // A byte search skips decoding the ~3k files that never mention the component.
      .filter((file) => readFileSync(file).includes(LEGACY_COMPONENT))
      .flatMap((file) =>
        findOffenseLines(readGuardFile(file)).map(
          (line) => `${path.relative(SOURCE_DIR, file)}:${line}`,
        ),
      );
    expect(offenses).toEqual([]);
  });
});
