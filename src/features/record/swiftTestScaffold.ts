import { z } from "zod/v4";

/**
 * Optional XCTest scaffold for an exported plan (#18161). `format: "xctest"` on exportPlan and
 * recordToolCalls end returns, beside the YAML, a minimal XCTestRunner `AutoMobileTestCase`
 * subclass and the bundle resource path its `planPath` names. The subclass only overrides
 * `planPath` and runs `executePlan()`, so it tracks the runner's public API, not its internals.
 */

export const PLAN_EXPORT_FORMATS = ["yaml", "xctest"] as const;
export type PlanExportFormat = (typeof PLAN_EXPORT_FORMATS)[number];

export const planExportFormatField = () =>
  z
    .enum(PLAN_EXPORT_FORMATS)
    .optional()
    .describe(
      'yaml (default) returns the plan only; xctest also returns an AutoMobileTestCase Swift subclass and the plan\'s test-bundle resource path in "xctest"',
    );

export const xcTestScaffoldSchema = z
  .object({
    className: z.string(),
    swiftFileName: z.string().describe("File to add to the XCTest target"),
    swiftSource: z.string().describe("AutoMobileTestCase subclass that runs the plan"),
    planFileName: z.string().describe("File name to save planContent as"),
    planResourcePath: z
      .string()
      .describe("Path of the plan inside the test bundle's resources; the class's planPath"),
  })
  .optional()
  .describe('format "xctest" only: Swift test class and plan resource path for the test bundle');

export type XCTestScaffold = NonNullable<z.infer<typeof xcTestScaffoldSchema>>;

/** Resource folder the docs and test bundles use for plans. */
const PLAN_RESOURCE_DIR = "test-plans";

const planNameWords = (planName: string): string[] => planName.match(/[A-Za-z0-9]+/g) ?? [];

const pascalCase = (words: string[]): string =>
  words.map((word) => word.charAt(0).toUpperCase() + word.slice(1)).join("");

/** `launch-reminders-app` → `LaunchRemindersAppTests`; a leading digit gets a `Plan` prefix. */
export const xcTestClassName = (planName: string): string => {
  const base = pascalCase(planNameWords(planName)) || "RecordedPlan";
  const identifier = /^[0-9]/.test(base) ? `Plan${base}` : base;
  return identifier.endsWith("Tests") ? identifier : `${identifier}Tests`;
};

/** `Launch Reminders App` → `launch-reminders-app.yaml`; only `[a-z0-9-]` reaches the path. */
export const planResourceFileName = (planName: string): string => {
  const slug = planNameWords(planName)
    .map((word) => word.toLowerCase())
    .join("-");
  return `${slug || "recorded-plan"}.yaml`;
};

const swiftTestCaseSource = (className: string, planResourcePath: string): string => {
  const testMethod = `test${className.replace(/Tests$/, "")}`;
  return [
    "import XCTest",
    "import XCTestRunner",
    "",
    `final class ${className}: AutoMobileTestCase {`,
    "    override var planPath: String {",
    `        "${planResourcePath}"`,
    "    }",
    "",
    `    func ${testMethod}() async throws {`,
    "        let result = try await executePlan()",
    '        XCTAssertTrue(result.success, result.error ?? "AutoMobile plan failed")',
    "    }",
    "}",
    "",
  ].join("\n");
};

export const buildXCTestScaffold = (planName: string): XCTestScaffold => {
  const className = xcTestClassName(planName);
  const planFileName = planResourceFileName(planName);
  const planResourcePath = `${PLAN_RESOURCE_DIR}/${planFileName}`;
  return {
    className,
    swiftFileName: `${className}.swift`,
    swiftSource: swiftTestCaseSource(className, planResourcePath),
    planFileName,
    planResourcePath,
  };
};

/** The `xctest` response field for `format`, or nothing for the default YAML-only export. */
export const xcTestScaffoldField = (
  format: PlanExportFormat | undefined,
  planName: string,
): { xctest?: XCTestScaffold } =>
  format === "xctest" ? { xctest: buildXCTestScaffold(planName) } : {};
