import { describe, expect, test } from "bun:test";
import { loadJobs } from "../helpers/workflowSteps";

describe("nightly iOS capability environment", () => {
  test("does not retain a simulator-only Reminders daemon job", () => {
    const job = loadJobs(".github/workflows/nightly.yml")["ios-xctest-runner-simulator-tests"];

    expect(job).toBeUndefined();
  });
});
