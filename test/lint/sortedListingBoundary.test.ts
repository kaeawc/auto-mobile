import { beforeAll, describe, expect, test } from "bun:test";

import path from "node:path";
import { sortedReaddirEntriesSync } from "../../src/utils/io";

import { parseGuardSource, unwrapCallee, readGuardFile, GuardVisitor as Visitor } from "./astGuard";

// Issue #10689: raw directory listings come back in filesystem order (hash order on ext4,
// roughly alphabetical on APFS/NTFS), so code and tests that observe them behave differently per
// platform. Every listing in src/ goes through the sorted helpers in src/utils/io.ts.
const SRC_DIR = path.join(import.meta.dir, "..", "..", "src");
const HELPER_FILE = path.join("utils", "io.ts");

/** Per-file exceptions, each with the reason raw listing order cannot reach any output. */
export const ALLOW_LIST: Readonly<Record<string, string>> = {};

const LISTING_CALLS = new Set(["readdirSync", "opendirSync", "opendir", "globSync", "readdir"]);
const FS_NAMESPACES = new Set(["fs", "nodeFs", "fsp", "fsPromises", "promises"]);
const FS_LISTING_MEMBERS = new Set([
  "readdir",
  "readdirSync",
  "opendir",
  "opendirSync",
  "glob",
  "globSync",
]);

/** 1-based lines of raw directory listings: bare listing calls, `fs.*` members and `new Glob`. */
export function findRawListings(source: string, file = "fixture.ts"): number[] {
  // Cheap prefilter: parsing every file is slow, so only files that mention a listing API at
  // all are parsed.
  if (!/readdir|opendir|[gG]lob/.test(source)) {
    return [];
  }
  const lineStarts = [0];
  for (const match of source.matchAll(/\n/g)) {
    lineStarts.push(match.index + 1);
  }
  const lineOf = (offset: number) => lineStarts.findLastIndex((start) => start <= offset) + 1;
  const lines = new Set<number>();
  new Visitor({
    CallExpression(node) {
      const callee = unwrapCallee(node.callee);
      if (callee.type === "Identifier" && LISTING_CALLS.has(callee.name)) {
        lines.add(lineOf(node.start));
      }
    },
    MemberExpression(node) {
      if (
        node.object.type === "Identifier" &&
        FS_NAMESPACES.has(node.object.name) &&
        !node.computed &&
        node.property.type === "Identifier" &&
        FS_LISTING_MEMBERS.has(node.property.name)
      ) {
        lines.add(lineOf(node.start));
      }
    },
    NewExpression(node) {
      const callee = node.callee;
      if (
        (callee.type === "Identifier" && callee.name === "Glob") ||
        (callee.type === "MemberExpression" &&
          callee.object.type === "Identifier" &&
          callee.object.name === "Bun" &&
          callee.property.type === "Identifier" &&
          callee.property.name === "Glob")
      ) {
        lines.add(lineOf(node.start));
      }
    },
  }).visit(parseGuardSource(file, source));
  return [...lines].sort((a, b) => a - b);
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
      return findRawListings(readGuardFile(file), file).map((line) => `src/${relative}:${line}`);
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
    expect(findRawListings("interface F { readdir(dirPath: string): Promise<string[]>; }")).toEqual(
      [],
    );
    expect(findRawListings("// readdirSync(dir)")).toEqual([]);
    expect(findRawListings("const note = 'readdirSync(dir)';")).toEqual([]);
    expect(findRawListings("const a = 1;\n\nconst b = fsPromises.readdir(dir);")).toEqual([3]);
  });
});
