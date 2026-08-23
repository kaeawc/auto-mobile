import { describe, expect, test } from "bun:test";
import { loadJobSteps, stepNamed } from "../helpers/workflowSteps";

const WORKFLOWS = [".github/workflows/pull_request.yml", ".github/workflows/merge.yml"] as const;

describe("Node test workflow isolation", () => {
  for (const workflow of WORKFLOWS) {
    test(`${workflow} prevents unit tests from starting a real adb daemon`, () => {
      const runTests = stepNamed(loadJobSteps(workflow, "mcp-build-and-test"), "Run Tests");

      expect(runTests).toBeDefined();
      expect(runTests?.env?.AUTOMOBILE_TEST_MODE).toBe("true");
    });
  }
});
