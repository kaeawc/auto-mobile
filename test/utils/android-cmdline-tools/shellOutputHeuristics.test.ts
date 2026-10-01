import { expect, test } from "bun:test";
import { outputReportsMissingPackage } from "../../../src/utils/android-cmdline-tools/shellOutputHeuristics";

test("outputReportsMissingPackage recognizes the package-manager marker", () => {
  expect(outputReportsMissingPackage("Unable to find package: com.example.missing")).toBe(true);
  expect(outputReportsMissingPackage("Package [com.example.app] (12345):")).toBe(false);
});
