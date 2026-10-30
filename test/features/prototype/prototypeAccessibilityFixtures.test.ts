import { beforeAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { lintPrototypeAccessibility } from "../../../src/features/prototype/prototypeAccessibilityLint";
import { validatePrototypeSpec } from "../../../src/features/prototype/prototypeValidation";

const directory = join(import.meta.dir, "../../fixtures/prototype-a11y");

/** One fixture per violation type (#14126); each differs from clean.json by one offending node. */
const FIXTURES = [
  ["unlabeled-control-tap", "unlabeled-control", "root.children[1]"],
  ["unlabeled-control-icon-button", "unlabeled-control", "root.children[2]"],
  ["unlabeled-image", "unlabeled-image", "root.children[3]"],
  ["unlabeled-text-field", "unlabeled-text-field", "root.children[4]"],
  ["low-contrast", "low-contrast", "root.children[5]"],
  ["small-touch-target", "small-touch-target", "root.children[6]"],
] as const;

const load = (name: string): string => readFileSync(join(directory, `${name}.json`), "utf8");

describe("prototype accessibility fixtures", () => {
  // The first validation pays the schema build; keep it out of the per-test budget.
  beforeAll(() => {
    validatePrototypeSpec(load("clean"));
  });

  test("clean.json validates and has no findings", () => {
    expect(validatePrototypeSpec(load("clean")).success).toBe(true);
    expect(lintPrototypeAccessibility(JSON.parse(load("clean"))).findings).toEqual([]);
  });

  for (const [name, rule, path] of FIXTURES) {
    test(`${name} validates and reports only ${rule} at ${path}`, () => {
      expect(validatePrototypeSpec(load(name)).success).toBe(true);
      const { findings } = lintPrototypeAccessibility(JSON.parse(load(name)));
      expect(findings.map((finding) => [finding.rule, finding.path])).toEqual([[rule, path]]);
    });
  }
});
