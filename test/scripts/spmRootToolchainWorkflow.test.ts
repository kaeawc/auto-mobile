import { describe, expect, test } from "bun:test";
import { loadJobSteps, loadJobs, stepNamed } from "../helpers/workflowSteps";

describe("root SPM toolchain floor workflow", () => {
  // The documented SwiftLint exception and the macOS-only installer-minimal matrix
  // leg route kaeawc-authored PRs to the self-hosted runner. Every other PR job
  // stays on a GitHub-hosted runner.
  const SELF_HOSTED_PR_EXCEPTIONS = new Set(["swiftlint", "installer-minimal"]);

  test("keeps every non-excepted pull-request job off the self-hosted runner", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    const prohibitedRunners = ["self-hosted", "automobile-mac"];
    const selfHostedJobs = Object.entries(jobs)
      .filter(
        ([name, job]) =>
          !SELF_HOSTED_PR_EXCEPTIONS.has(name) &&
          prohibitedRunners.some((runner) => JSON.stringify(job["runs-on"] ?? "").includes(runner)),
      )
      .map(([name]) => name);

    expect(selfHostedJobs).toEqual([]);
  });

  test("routes swiftlint to the self-hosted runner behind the kaeawc author guard", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    const runsOn = JSON.stringify(jobs["swiftlint"]?.["runs-on"] ?? "");

    expect(runsOn).toContain("automobile-mac");
    expect(runsOn).toContain("github.event.pull_request.user.login == 'kaeawc'");
    // Fallback to a GitHub-hosted runner for every other author.
    expect(runsOn).toContain("macos-26");
  });

  test("routes only kaeawc's macOS installer-minimal leg to the self-hosted runner", () => {
    const jobs = loadJobs(".github/workflows/pull_request.yml");
    const runsOn = JSON.stringify(jobs["installer-minimal"]?.["runs-on"] ?? "");

    expect(runsOn).toContain("matrix.os == 'macos-latest'");
    expect(runsOn).toContain("github.event.pull_request.user.login == 'kaeawc'");
    expect(runsOn).toContain("automobile-mac");
    expect(runsOn).toContain("|| matrix.os");
  });

  test("pins the Swift package matrix to its configured Xcode floor", () => {
    const steps = loadJobSteps(".github/workflows/pull_request.yml", "ios-swift-packages");
    const selectXcode = stepNamed(steps, "Select Xcode ${{ matrix.config.xcode }}");

    expect(selectXcode?.if).toBeUndefined();
    expect(selectXcode?.uses).toBe("maxim-lobanov/setup-xcode@v1");
    expect(selectXcode?.with?.["xcode-version"]).toBe("${{ matrix.config.xcode }}");
  });

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
