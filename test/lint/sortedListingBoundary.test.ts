import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import path from "node:path";
import { sortedReaddirEntriesSync } from "../../src/utils/io";
import { blankComments } from "./blankComments";

// Issue #10689: raw directory listings come back in filesystem order (hash order on ext4,
// roughly alphabetical on APFS/NTFS), so code and tests that observe them behave differently per
// platform. Every listing in src/ goes through the sorted helpers in src/utils/io.ts.
const SRC_DIR = path.join(import.meta.dir, "..", "..", "src");
const HELPER_FILE = path.join("utils", "io.ts");

/** Per-file exceptions, each with the reason raw listing order cannot reach any output. */
export const ALLOW_LIST: Readonly<Record<string, string>> = {};

const RAW_LISTING_PATTERNS: readonly RegExp[] = [
  /(?<![\w.])(?:readdirSync|opendirSync|opendir|globSync)\s*\(/,
  /(?<![\w.])(?:fs|nodeFs|fsp|fsPromises|promises)\.(?:readdir|readdirSync|opendir|opendirSync|glob|globSync)\b/,
  // A bare imported `readdir(dir)` call; method declarations (`readdir(path: string)`) carry a type.
  /(?<![\w.])readdir\((?![^)]*:)/,
  /\bnew\s+(?:Bun\.)?Glob\s*\(/,
];

export function findRawListings(source: string): number[] {
  // Cheap prefilter: parsing every file for comments is slow, so only files that mention a
  // listing API at all are blanked and scanned line by line.
  if (!/readdir|opendir|[gG]lob/.test(source)) {
    return [];
  }
  return blankComments(source)
    .split(/\r?\n/)
    .flatMap((line, index) =>
      RAW_LISTING_PATTERNS.some((pattern) => pattern.test(line)) ? [index + 1] : [],
    );
}

function sourceFiles(directory: string): string[] {
  return sortedReaddirEntriesSync(directory).flatMap((entry) => {
    const file = path.join(directory, entry.name);
    return entry.isDirectory()
      ? sourceFiles(file)
      : entry.isFile() && /\.(?:ts|tsx|mts|cts)$/.test(entry.name)
        ? [file]
        : [];
  });
}

describe("sorted listing boundary (issue #10689)", () => {
  let files: string[];
  let offenders: string[];

  // The repository scan is captured once, outside the per-test budget.
  beforeAll(() => {
    files = sourceFiles(SRC_DIR);
    offenders = files.flatMap((file) => {
      const relative = path.relative(SRC_DIR, file);
      if (relative === HELPER_FILE || relative in ALLOW_LIST) {
        return [];
      }
      return findRawListings(readFileSync(file, "utf8")).map((line) => `src/${relative}:${line}`);
    });
  }, 30_000);

  test("src/ lists directories only through the sorted helpers in utils/io.ts", () => {
    expect(files.length).toBeGreaterThan(100);
    expect(offenders, `use sortedReaddir*/ from src/utils/io:\n${offenders.join("\n")}`).toEqual(
      [],
    );
  });

  test("every allow-list entry names an existing file and a reason", () => {
    for (const [relative, reason] of Object.entries(ALLOW_LIST)) {
      expect(reason.length).toBeGreaterThan(0);
      expect(files).toContain(path.join(SRC_DIR, relative));
    }
  });

  test("detects raw listings but not sorted helpers, declarations or comments", () => {
    expect(findRawListings("const a = readdirSync(dir, { withFileTypes: true });")).toEqual([1]);
    expect(findRawListings("await fs.readdir(dir);")).toEqual([1]);
    expect(findRawListings("await readdir(dir);")).toEqual([1]);
    expect(findRawListings("const g = new Bun.Glob('**/*.ts');")).toEqual([1]);
    expect(findRawListings("await sortedReaddir(dir);")).toEqual([]);
    expect(findRawListings("await this.fileSystem.readdir(dir);")).toEqual([]);
    expect(findRawListings("  readdir(dirPath: string): Promise<string[]>;")).toEqual([]);
    expect(findRawListings("// readdirSync(dir)")).toEqual([]);
  });
});
