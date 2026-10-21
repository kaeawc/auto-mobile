import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

// A literal NUL or other control byte in a TypeScript source makes grep, ripgrep
// and editors treat the file as binary, so reviewers and codemods silently skip
// it. Write such characters as escapes (\u0000, \t, ...) instead. Tab, LF and CR
// are legitimate in source text.
const root = path.resolve(import.meta.dir, "../..");
const SCANNED_DIRS = ["src", "test"];

export function findRawControlBytes(source: Uint8Array): number[] {
  const offsets: number[] = [];
  for (let index = 0; index < source.length; index++) {
    const byte = source[index];
    if (byte < 32 && byte !== 9 && byte !== 10 && byte !== 13) {
      offsets.push(index);
    }
  }
  return offsets;
}

function typeScriptFiles(directory: string): string[] {
  return readdirSync(path.join(root, directory), { recursive: true })
    .map((entry) => String(entry))
    .filter((entry) => entry.endsWith(".ts"))
    .map((entry) => path.join(directory, entry));
}

let offenders: string[];
// The tree walk reads every TypeScript file, which takes several seconds on a Windows runner (file
// opens are slow there), longer than bun's 5 s hook default. Read concurrently, and give the hook an
// explicit ceiling so the walk stays out of the 100 ms per-test budget without timing out.
const TREE_SCAN_TIMEOUT_MS = 60_000;
beforeAll(async () => {
  const files = SCANNED_DIRS.flatMap(typeScriptFiles);
  const found = await Promise.all(
    files.map(async (file) => {
      const offsets = findRawControlBytes(await readFile(path.join(root, file)));
      return offsets.length > 0 ? [`${file} (byte offsets ${offsets.slice(0, 3).join(", ")})`] : [];
    }),
  );
  offenders = found.flat();
}, TREE_SCAN_TIMEOUT_MS);

describe("raw control bytes in TypeScript sources", () => {
  test("finds NUL and other control bytes but not tab, LF or CR", () => {
    const source = Buffer.from("a\tb\nc\rd\u0000e\u001bf");
    expect(findRawControlBytes(source)).toEqual([7, 9]);
  });

  test("contains no literal control bytes beyond whitespace in src/ or test/", () => {
    expect(
      offenders,
      "Replace raw control bytes with escapes such as \\u0000 so grep and review tools can read the file.",
    ).toEqual([]);
  });
});
