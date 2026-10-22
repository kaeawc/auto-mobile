import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  DOC_PATTERN_LITERALS,
  TEST_GUARDED_DOCS,
  createPathClassifier,
  isDocFile,
  parseWorkflowPathFilters,
} from "../../scripts/ci/prPathClassification";

const workflow = readFileSync(
  resolve(import.meta.dir, "../../.github/workflows/pull_request.yml"),
  "utf8",
);
const classify = createPathClassifier(parseWorkflowPathFilters(workflow));

describe("parseWorkflowPathFilters", () => {
  test("reads the android, ios and ts globs from the real pull_request.yml", () => {
    const filters = parseWorkflowPathFilters(workflow);
    expect(filters.android).toContain("android/**");
    expect(filters.ios).toContain("ios/**");
    expect(filters.ts).toContain("src/**");
  });

  test("throws when a filter step is missing", () => {
    expect(() => parseWorkflowPathFilters("jobs:\n  a:\n    steps: []\n")).toThrow(
      "filter-android",
    );
  });
});

describe("docs-only patterns", () => {
  test("every mirrored pattern still appears in the workflow's documentation step", () => {
    // The step is inline github-script JS, so the patterns cannot be parsed as data. This guard
    // fails when the workflow drops or edits one so the mirror cannot silently drift.
    for (const literal of DOC_PATTERN_LITERALS) {
      expect(workflow.includes(literal)).toBe(true);
    }
    for (const doc of TEST_GUARDED_DOCS) {
      expect(workflow.includes(doc)).toBe(true);
    }
  });

  test("recognises documentation files and the test-guarded exception", () => {
    expect(isDocFile("README.md")).toBe(true);
    expect(isDocFile("docs/a/b.png")).toBe(true);
    expect(isDocFile("docs/using/screen-control.md")).toBe(false);
    expect(isDocFile("src/a.ts")).toBe(false);
  });
});

describe("createPathClassifier", () => {
  test("classifies by the workflow's own filters", () => {
    expect(classify(["src/a.ts", "test/a.test.ts"])).toBe("ts-only");
    expect(classify(["android/app/build.gradle.kts", "src/a.ts"])).toBe("android");
    expect(classify(["ios/App/App.swift"])).toBe("ios");
    expect(classify(["ios/prototype-agent/Sources/Example/Example.swift"])).toBe("ios");
    // The root manifest builds the published AutoMobilePrototype library product (#14457).
    expect(classify(["Package.swift"])).toBe("ios");
    expect(classify(["ios/App/App.swift", "android/app/Main.kt"])).toBe("mixed");
  });

  test("docs-only and shell-only changes are shell-docs", () => {
    expect(classify(["docs/index.md", "README.md"])).toBe("shell-docs");
    expect(classify(["scripts/a.sh", "test/bats/a.bats"])).toBe("shell-docs");
    expect(classify([".github/workflows/nightly.yml"])).toBe("shell-docs");
  });

  test("a script plus TypeScript is ts-only, and an unknown file list is unknown", () => {
    expect(classify(["scripts/a.sh", "scripts/b.ts"])).toBe("ts-only");
    expect(classify(null)).toBe("unknown");
    expect(classify([])).toBe("unknown");
  });
});
