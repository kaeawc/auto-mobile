import { describe, expect, test } from "bun:test";
import { loadJobSteps, stepNamed } from "../helpers/workflowSteps";

// PR unit runs live in the required build-and-test jobs (#10893, #10894).
const UNIT_JOBS = [
  [".github/workflows/pull_request.yml", "ts-build-and-test"],
  [".github/workflows/pull_request.yml", "mcp-build-and-test"],
  [".github/workflows/merge.yml", "node-unit-tests"],
] as const;

describe("Node test workflow isolation", () => {
  for (const [workflow, job] of UNIT_JOBS) {
    test(`${workflow}:${job} prevents unit tests from starting a real adb daemon`, () => {
      const runTests = stepNamed(loadJobSteps(workflow, job), "Run complete unit lane");

      expect(runTests).toBeDefined();
      expect(runTests?.env?.AUTOMOBILE_TEST_MODE).toBe("true");
    });
  }
});
