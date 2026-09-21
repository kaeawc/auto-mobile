import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { load } from "js-yaml";
import { loadJobSteps, stepNamed, type WorkflowStep } from "../helpers/workflowSteps";

const PRODUCT_BOOT =
  "bun run src/index.ts --boot-device --platform ios --create-if-missing --timeout-ms 600000";

function actionSteps(): WorkflowStep[] {
  const action = load(
    readFileSync(".github/actions/ios-simulator-bring-up/action.yml", "utf8"),
  ) as {
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
    expect(boot?.run).toContain(
      '--min-os-version "${ios_version}" --max-os-version "${ios_version}"',
    );
    expect(steps.some((step) => step.run?.includes("boot-simulator.sh"))).toBe(false);
  });

  test("keeps the shared CtrlProxy simulator stable while isolating odd-width coverage", () => {
    const steps = loadJobSteps(
      ".github/workflows/pull_request.yml",
      "ios-xctest-runner-simulator-tests",
    );
    const boot = stepNamed(steps, "Boot iOS Simulator for CtrlProxy UI tests (Xcode 26.5)");

    expect(boot?.run).toContain(PRODUCT_BOOT);
    expect(boot?.run).toContain("xcrun --sdk iphonesimulator --show-sdk-version");
    expect(boot?.run).toContain(
      '--min-os-version "${ios_version}" --max-os-version "${ios_version}"',
    );
    expect(boot?.run).not.toContain('--name "iPhone 15"');
    expect(boot?.run).toContain("simulator_udid=");
    expect(steps.some((step) => step.name === "Shutdown iOS Simulators")).toBe(false);
    expect(steps.some((step) => step.name === "Boot iOS Simulator (Xcode 26.5)")).toBe(false);

    const uiTests = stepNamed(steps, "Run selected CtrlProxy iOS tests (Xcode 26.5)");
    expect(uiTests?.run).not.toContain(
      "-only-testing:CtrlProxyUITests/HierarchyIntegrationTests/testScreenshotMatchesNativeDimensionsOnOddWidthDevice",
    );

    const oddWidthTest = stepNamed(steps, "Run odd-width CtrlProxy screenshot test (iPhone 15)");
    expect(oddWidthTest?.run).toContain(PRODUCT_BOOT);
    expect(oddWidthTest?.run).toContain('--name "iPhone 15"');
    expect(oddWidthTest?.run).toContain("com.apple.CoreSimulator.SimDeviceType.iPhone-15");
    expect(oddWidthTest?.run).toContain(".deviceTypeIdentifier");
    expect(oddWidthTest?.run).toContain("xcrun simctl shutdown");
    expect(oddWidthTest?.run).toContain(
      "-only-testing:CtrlProxyUITests/HierarchyIntegrationTests/testScreenshotMatchesNativeDimensionsOnOddWidthDevice",
    );
  });
});
