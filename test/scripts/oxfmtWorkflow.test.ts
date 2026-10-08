import { describe, expect, test } from "bun:test";
import { loadJobSteps, loadWorkflow, stepNamed } from "../helpers/workflowSteps";

const WORKFLOW = ".github/workflows/pull_request.yml";
const MERGE_WORKFLOW = ".github/workflows/merge.yml";
const JOB_ID = "fast-validation";
const FORMAT_STEP = "Check formatting";

describe("#5531 formatting workflow", () => {
  test("runs the formatter check whenever a formatter-supported path changes", () => {
    const steps = loadJobSteps(WORKFLOW, JOB_ID);
    const format = stepNamed(steps, FORMAT_STEP);
    const workflow = loadWorkflow(WORKFLOW);

    expect(steps.length).toBeGreaterThan(0);
    expect(format).toBeDefined();
    expect(format?.if).toBe("needs.detect-changes.outputs.format_changed == 'true'");
    expect(format?.run).toContain("if ! bun run format:check; then");
    expect(format?.run).toContain("exit 1");
    // Folded into Fast Validation to save a runner slot per PR; it must not
    // come back as a separate job that Fast Validation waits on.
    expect(workflow.jobs?.["format-check"]).toBeUndefined();
  });

  test("treats Markdown and workflow configuration as formatter inputs", () => {
    const steps = loadJobSteps(WORKFLOW, "detect-changes");
    const filter = stepNamed(steps, "Check for formatting-related changes");
    const filters = filter?.with?.filters;

    expect(filters).toContain("'**/*.md'");
    expect(filters).toContain("'**/*.yml'");
    expect(filters).toContain("'.oxfmtrc.json'");
  });

  test("runs formatting inside required Fast Validation before the slow validators", () => {
    const fastValidation = loadWorkflow(WORKFLOW).jobs?.["fast-validation"];
    expect(fastValidation?.needs).toEqual(["detect-changes"]);
    const steps = loadJobSteps(WORKFLOW, "fast-validation");
    const guard = stepNamed(steps, "Require change detection result");

    expect(guard).toBeDefined();
    expect(guard?.run).toContain('detect_result="${{ needs.detect-changes.result }}"');
    expect(guard?.run).toContain('if [[ "$detect_result" != "success" ]]; then');
    expect(guard?.run).toContain(
      'echo "Change detection concluded $detect_result; formatter gate cannot be trusted"',
    );
    const formatIndex = steps.findIndex((step) => step.name === FORMAT_STEP);
    const validatorsIndex = steps.findIndex((step) => step.name === "Run fast validation checks");
    expect(formatIndex).toBeGreaterThan(-1);
    expect(formatIndex).toBeLessThan(validatorsIndex);
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
