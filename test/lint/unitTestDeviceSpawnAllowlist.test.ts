import { expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../../", import.meta.url));
const lines = readFileSync(resolve(root, "scripts/unit-test-device-spawn-allowlist.txt"), "utf8")
  .replace(/\n$/, "")
  .split("\n");
const entries = lines.slice(1);

test("device-spawn allow-list has a header and sorted unique entries without blank lines", () => {
  expect(lines[0]?.startsWith("# ")).toBe(true);
  expect(entries).toEqual(
    [...new Set(entries)].sort((left, right) =>
      Buffer.compare(Buffer.from(left), Buffer.from(right)),
    ),
  );
  expect(entries.every((entry) => entry.length > 0)).toBe(true);
});

test("device-spawn allow-list only contains existing repo-relative unit test files", () => {
  for (const entry of entries) {
    expect(entry.startsWith("test/")).toBe(true);
    expect(entry.endsWith(".test.ts")).toBe(true);
    expect(entry.endsWith(".integration.test.ts")).toBe(false);
    expect(entry.startsWith("test/stress/")).toBe(false);
    expect(entry.split("/").some((part) => ["", ".", ".."].includes(part))).toBe(false);
    expect(entry.includes("\\")).toBe(false);
    expect(existsSync(resolve(root, entry))).toBe(true);
  }
});
