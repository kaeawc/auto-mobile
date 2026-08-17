import { describe, expect, test } from "bun:test";
import { loadJobSteps, stepNamed } from "../helpers/workflowSteps";

describe("pull request auto-chore detection", () => {
  test("uses the pull request event label snapshot without a second labels API request", () => {
    const steps = loadJobSteps(".github/workflows/pull_request.yml", "detect-changes");
    const check = stepNamed(steps, "Check for auto chore changes");

    const script = check?.with?.script;
    expect(script).toContain("context.payload.pull_request.labels ?? []");
    expect(script).not.toContain("listLabelsOnIssue");
  });
});
