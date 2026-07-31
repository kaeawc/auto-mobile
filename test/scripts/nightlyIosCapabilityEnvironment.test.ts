import { describe, expect, test } from "bun:test";
import { loadJobs } from "../helpers/workflowSteps";

describe("nightly iOS capability environment", () => {
  test("starts both Reminders daemons with the test-authoring capability", () => {
    const job = loadJobs(".github/workflows/nightly.yml")["ios-xctest-runner-simulator-tests"];

    expect(job).toBeDefined();
    expect(job?.env?.AUTOMOBILE_TOOLSET_TEST_AUTHORING).toBe("1");
  });
});
