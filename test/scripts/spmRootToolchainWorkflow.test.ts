import { describe, expect, test } from "bun:test";
import { loadJobSteps, stepNamed } from "../helpers/workflowSteps";

describe("root SPM toolchain floor workflow", () => {
  test("selects Xcode 26.5 on every runner before building the root package", () => {
    const steps = loadJobSteps(".github/workflows/pull_request.yml", "ios-spm-root-package-build");
    const selectXcode = stepNamed(steps, "Select Xcode 26.5");

    expect(steps.length).toBeGreaterThan(0);
    expect(selectXcode).toBeDefined();
    expect(selectXcode?.if).toBeUndefined();
    expect(selectXcode?.uses).toBe("maxim-lobanov/setup-xcode@v1");
    expect(selectXcode?.with?.["xcode-version"]).toBe("26.5");
    expect(steps.indexOf(selectXcode!)).toBeLessThan(
      steps.findIndex((step) => step.name === "Build root Package.swift"),
    );
  });
});
