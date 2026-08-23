import { describe, expect, test } from "bun:test";
import { loadJobSteps, loadWorkflow, stepNamed } from "../helpers/workflowSteps";

const WORKFLOW = ".github/workflows/pull_request.yml";
const JOB_ID = "format-check";
const FORMAT_STEP = "Check formatting";

describe("#5531 formatting workflow", () => {
  test("runs the formatter check whenever a formatter-supported path changes", () => {
    const steps = loadJobSteps(WORKFLOW, JOB_ID);
    const format = stepNamed(steps, FORMAT_STEP);
    const workflow = loadWorkflow(WORKFLOW);

    expect(steps.length).toBeGreaterThan(0);
    expect(workflow.jobs?.[JOB_ID]?.if).toBe(
      "needs.detect-changes.outputs.format_changed == 'true'",
    );
    expect(format).toBeDefined();
    expect(format?.run).toBe("bun run format:check");
  });

  test("treats Markdown and workflow configuration as formatter inputs", () => {
    const steps = loadJobSteps(WORKFLOW, "detect-changes");
    const filter = stepNamed(steps, "Check for formatting-related changes");
    const filters = filter?.with?.filters;

    expect(filters).toContain("'**/*.md'");
    expect(filters).toContain("'**/*.yml'");
    expect(filters).toContain("'.oxfmtrc.json'");
  });

  test("makes formatting a dependency of required Fast Validation", () => {
    const fastValidation = loadWorkflow(WORKFLOW).jobs?.["fast-validation"];
    expect(fastValidation?.needs).toContain("format-check");
    expect(loadJobSteps(WORKFLOW, "fast-validation").map((step) => step.name)).toContain(
      "Require formatter result",
    );
  });
});
