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

describe("shared AutoMobile directory path literals", () => {
  test("does not use the legacy .automobile path component", () => {
    const offenses = sourceFiles(SOURCE_DIR).flatMap((file) => {
      const source = readFileSync(file, "utf8");
      const lines = source.split(/\r?\n/);
      return lines.flatMap((line, index) =>
        /(["'])\.automobile\1/.test(line)
          ? [`${path.relative(SOURCE_DIR, file)}:${index + 1}`]
          : [],
      );
    });

    expect(offenses).toEqual([]);
  });
});
