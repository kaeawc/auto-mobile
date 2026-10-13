import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  createCircleciMacosMatcher,
  parseCircleciMacosJobNames,
} from "../../scripts/ci/circleciMacosJobs";

const config = readFileSync(
  resolve(import.meta.dir, "../../.circleci/continue_config.yml"),
  "utf8",
);
const names = parseCircleciMacosJobNames(config);

test("reads macOS workflow display names from the real config", () => {
  expect(names).toContain("ios-playground-tests");
  expect(names).toContain("Build Xcode Projects (main)");
  expect(names).toContain("Build Desktop App (macos)");
  expect(names).not.toContain("detect-main-macos-changes");
});

test("matches exact names and matrix suffixes", () => {
  const match = createCircleciMacosMatcher(names);
  expect(match("Build Xcode Projects (main)")).toBe(true);
  expect(match("Build Xcode Projects (main)-1")).toBe(true);
  expect(match("Build Xcode Projects (main)ish")).toBe(false);
  expect(match("detect-main-macos-changes")).toBe(false);
});

test("supports direct macos jobs, string executors, object executors and unnamed entries", () => {
  const yaml = `executors:
  apple:
    macos: {}
jobs:
  direct:
    macos: {}
  string:
    executor: apple
  object:
    executor: {name: apple}
  linux:
    docker: []
workflows:
  checks:
    jobs:
      - direct
      - string: {name: Display}
      - object: {}
      - linux
`;
  expect(parseCircleciMacosJobNames(yaml)).toEqual(["Display", "direct", "object"]);
  expect(parseCircleciMacosJobNames("null")).toEqual([]);
});
