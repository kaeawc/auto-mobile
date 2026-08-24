import { describe, expect, test } from "bun:test";
import { loadJobSteps, loadWorkflow, stepNamed } from "../helpers/workflowSteps";

const WORKFLOW = ".github/workflows/pull_request.yml";
const MERGE_WORKFLOW = ".github/workflows/merge.yml";
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
    const guard = stepNamed(loadJobSteps(WORKFLOW, "fast-validation"), "Require formatter result");

    expect(guard).toBeDefined();
    expect(guard?.run).toContain('detect_result="${{ needs.detect-changes.result }}"');
    expect(guard?.run).toContain('if [[ "$detect_result" != "success" ]]; then');
    expect(guard?.run).toContain(
      'echo "Change detection concluded $detect_result; formatter gate cannot be trusted"',
    );
    expect(guard?.run).toContain('formatter_result="${{ needs.format-check.result }}"');
    expect(guard?.run).toContain(
      'if [[ "$formatter_result" == "failure" || "$formatter_result" == "cancelled" ]]; then',
    );
  });

  test("runs the full-tree formatter backstop after merge", () => {
    const steps = loadJobSteps(MERGE_WORKFLOW, "oxfmt");
    const format = stepNamed(steps, "Run oxfmt");

    expect(steps.length).toBeGreaterThan(0);
    expect(format?.run).toBe("bun run format:check");
    expect(steps.some((step) => step.uses === "actions/checkout@v6")).toBe(true);
    expect(steps.some((step) => step.uses === "oven-sh/setup-bun@v2")).toBe(true);
  });
});
