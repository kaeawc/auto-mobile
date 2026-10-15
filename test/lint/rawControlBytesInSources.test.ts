import { beforeAll, describe, expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
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
// The tree walk reads every TypeScript file; beforeAll keeps it out of the 100 ms per-test budget.
beforeAll(() => {
  offenders = SCANNED_DIRS.flatMap(typeScriptFiles).flatMap((file) => {
    const offsets = findRawControlBytes(readFileSync(path.join(root, file)));
    return offsets.length > 0 ? [`${file} (byte offsets ${offsets.slice(0, 3).join(", ")})`] : [];
  });
});

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
