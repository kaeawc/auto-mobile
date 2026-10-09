import { beforeAll, expect, test } from "bun:test";
import { readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { CORESIMULATOR_DEVICE_SET_PATH_ENV } from "../../src/utils/workingDirectory";
import { blankComments } from "../lint/blankComments";

// Reading every source file can exceed Bun's default hook limit on loaded CI runners.
const TREE_SCAN_HOOK_TIMEOUT_MS = 20_000;
const literal = new RegExp(`\\b${CORESIMULATOR_DEVICE_SET_PATH_ENV}\\b`);
// Files that still name the literal once comments are blanked. Parsing runs in
// beforeAll so the TypeScript parser's first-use warm-up is not charged to a test.
const violations: string[] = [];

beforeAll(() => {
  const sourceRoot = new URL("../../src/", import.meta.url);
  for (const file of readdirSync(sourceRoot, { recursive: true })) {
    if (!file.endsWith(".ts")) {
      continue;
    }
    const source = readFileSync(new URL(file, sourceRoot), "utf8");
    // Only parse candidates; imports and computed keys end with _ENV and
    // cannot match the complete name. Reuse the structured comment stripper.
    if (literal.test(source) && literal.test(withoutDefinition(file, blankComments(source)))) {
      violations.push(file);
    }
  }
}, TREE_SCAN_HOOK_TIMEOUT_MS);

function withoutDefinition(file: string, code: string): string {
  if (file !== join("utils", "workingDirectory.ts")) {
    return code;
  }
  return code.replace(
    `export const CORESIMULATOR_DEVICE_SET_PATH_ENV = "${CORESIMULATOR_DEVICE_SET_PATH_ENV}";`,
    "",
  );
}

test("keeps the unverified CoreSimulator environment name deliberate", () => {
  expect(CORESIMULATOR_DEVICE_SET_PATH_ENV).toBe("CORESIMULATOR_DEVICE_SET_PATH");
});

test("defines the device-set environment name only in workingDirectory", () => {
  expect(violations).toEqual([]);
});
