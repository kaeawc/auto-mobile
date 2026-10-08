import { describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import {
  compareCodeUnits,
  sortedReaddir,
  sortedReaddirEntries,
  sortedReaddirEntriesSync,
  sortedReaddirSync,
} from "../../src/utils/io";

// Created out of order, with names a locale collation would order differently
// (uppercase before lowercase, "_" before letters in code-unit order).
const NAMES = ["b.json", "a.json", "Z.txt", "_x", "ä.txt", "a.dylib"];
const EXPECTED = ["Z.txt", "_x", "a.dylib", "a.json", "b.json", "ä.txt"];

async function withTree(run: (dir: string) => Promise<void> | void): Promise<void> {
  const dir = mkdtempSync(path.join(tmpdir(), "sorted-listing-"));
  try {
    for (const name of NAMES) {
      writeFileSync(path.join(dir, name), "");
    }
    mkdirSync(path.join(dir, "c-dir"));
    await run(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe("sorted directory listings (#10689)", () => {
  test("compareCodeUnits orders by code unit, not locale", () => {
    expect(["b", "B", "a", "_"].sort(compareCodeUnits)).toEqual(["B", "_", "a", "b"]);
    expect(compareCodeUnits("a", "a")).toBe(0);
  });

  test("sortedReaddir and sync variant return code-unit order", async () => {
    await withTree(async (dir) => {
      const expected = [...EXPECTED, "c-dir"].sort(compareCodeUnits);
      expect(await sortedReaddir(dir)).toEqual(expected);
      expect(sortedReaddirSync(dir)).toEqual(expected);
    });
  });

  test("entry variants sort by name and keep type info", async () => {
    await withTree(async (dir) => {
      const entries = await sortedReaddirEntries(dir);
      expect(entries.map((entry) => entry.name)).toEqual(
        sortedReaddirEntriesSync(dir).map((entry) => entry.name),
      );
      expect(entries.map((entry) => entry.name)).toEqual(
        [...EXPECTED, "c-dir"].sort(compareCodeUnits),
      );
      expect(entries.find((entry) => entry.name === "c-dir")?.isDirectory()).toBe(true);
    });
  });
});
