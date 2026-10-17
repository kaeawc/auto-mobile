import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

// Structural checks on the committed file-size baseline (#11784). The ratchet itself is
// exercised by test/bats/file-size-baseline.bats and by scripts/lint.sh.
const ROOT = join(import.meta.dir, "../..");
const CAP = 1000;

function rows(): Array<{ count: number; file: string }> {
  // Windows checkouts are CRLF; split on either line ending so file names carry no "\r".
  return readFileSync(join(ROOT, "scripts/file-size-baseline.txt"), "utf8")
    .split(/\r?\n/)
    .filter((line) => line !== "" && !line.startsWith("#"))
    .map((line) => {
      const [count, file] = line.split("\t");
      return { count: Number(count), file: file ?? "" };
    });
}

describe("file-size baseline", () => {
  test("lists only existing src files over the cap, sorted, once each", () => {
    const entries = rows();
    expect(entries.length).toBeGreaterThan(0);
    for (const { count, file } of entries) {
      expect(Number.isInteger(count) && count > CAP).toBe(true);
      expect(file.startsWith("src/") && file.endsWith(".ts")).toBe(true);
      expect(existsSync(join(ROOT, file))).toBe(true);
    }
    const files = entries.map((entry) => entry.file);
    expect(files).toEqual([...files].sort());
    expect(new Set(files).size).toBe(files.length);
  });

  test("recorded counts are at least the current non-blank line counts", () => {
    for (const { count, file } of rows()) {
      const actual = readFileSync(join(ROOT, file), "utf8")
        .split(/\r?\n/)
        .filter((line) => /\S/.test(line)).length;
      expect({ file, ok: actual <= count }).toEqual({ file, ok: true });
    }
  });

  test("lint.sh runs the ratchet and package.json exposes the update command", () => {
    expect(readFileSync(join(ROOT, "scripts/lint.sh"), "utf8")).toContain(
      "bash scripts/file-size-baseline.sh",
    );
    const pkg = JSON.parse(readFileSync(join(ROOT, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["lint:file-size:baseline"]).toBe(
      "bash scripts/file-size-baseline.sh --update",
    );
  });
});
