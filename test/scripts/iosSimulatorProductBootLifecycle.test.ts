import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { loadJobSteps, stepNamed, type WorkflowStep } from "../helpers/workflowSteps";

const PRODUCT_BOOT = "bun run src/index.ts --boot-device --platform ios --create-if-missing --timeout-ms 600000";

function actionSteps(): WorkflowStep[] {
  const action = load(readFileSync(".github/actions/ios-simulator-bring-up/action.yml", "utf8")) as {
    runs?: { steps?: WorkflowStep[] };
  };
  return action.runs?.steps ?? [];
}

describe("iOS CI product boot lifecycle", () => {
  test("the shared bring-up action boots through the product command, not the deleted wrapper", () => {
    const steps = actionSteps();
    const boot = stepNamed(steps, "Boot iOS Simulator with AutoMobile product boot");

    expect(boot?.run).toContain(PRODUCT_BOOT);
    expect(boot?.run).toContain("xcrun --sdk iphonesimulator --show-sdk-version");
    expect(boot?.run).toContain('--min-os-version "${ios_version}" --max-os-version "${ios_version}"');
    expect(steps.some(step => step.run?.includes("boot-simulator.sh"))).toBe(false);
  });

  test("the CtrlProxy UI boot remains available to its Xcode test without a shutdown and second boot", () => {
    const steps = loadJobSteps(".github/workflows/pull_request.yml", "ios-xctest-runner-simulator-tests");
    const boot = stepNamed(steps, "Boot iOS Simulator for CtrlProxy UI tests (Xcode 26.5)");

    expect(boot?.run).toContain(PRODUCT_BOOT);
    expect(boot?.run).toContain("xcrun --sdk iphonesimulator --show-sdk-version");
    expect(boot?.run).toContain('--min-os-version "${ios_version}" --max-os-version "${ios_version}"');
    expect(boot?.run).toContain("simulator_udid=");
    expect(steps.some(step => step.name === "Shutdown iOS Simulators")).toBe(false);
    expect(steps.some(step => step.name === "Boot iOS Simulator (Xcode 26.5)")).toBe(false);
  });
});
