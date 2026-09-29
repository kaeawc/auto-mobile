import { describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

const SOURCE_DIR = path.join(import.meta.dir, "..", "..", "src");

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)
        ? [file]
        : [];
  });
}

function findOffenseLines(source: string): number[] {
  if (!source.includes(".automobile")) {
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
  test("does not use the legacy .automobile path component", () => {
    const offenses = sourceFiles(SOURCE_DIR).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      return findOffenseLines(source).map((line) => `${path.relative(SOURCE_DIR, file)}:${line}`);
    });

    expect(offenses).toEqual([]);
  });
});
