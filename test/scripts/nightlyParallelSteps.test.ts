import { describe, expect, test } from "bun:test";
import {
  indexOfNamed,
  indexOfWaitOn,
  loadJobSteps,
  loadWorkflow,
  stepNamed,
} from "../helpers/workflowSteps";

// Guards issue #4128: three independent wins in nightly.yml.
//
//  5a `ios-xctest-runner-simulator-tests` — `gem install xcpretty` is network
//     I/O and its only consumer is ctrl-proxy-build-for-testing.sh (which pipes
//     to xcpretty). Background it and hoist the npm-package setup above the
//     build so both overlap it, then re-sync before the build.
//  5b `ios-xcode-build-sweep` — the XcodeGen install is network I/O and the
//     simulator-runtime ensure never touches xcodegen, so they overlap. The
//     barrier MUST precede `Generate Xcode Projects`: both
//     xcodegen-generate.sh and xcode-build.sh re-invoke install-xcodegen.sh,
//     and concurrent installs against one prefix are a documented corruption
//     race ("File exists", nested share/xcodegen/xcodegen/).
//  5c the standalone `Setup Bun` step was redundant —
//     setup-auto-mobile-npm-package already runs oven-sh/setup-bun@v2 at the
//     same pinned 1.3.9.

const WORKFLOW = ".github/workflows/nightly.yml";

describe("#4128 nightly — XcodeGen overlap in ios-xcode-build-sweep", () => {
  const steps = loadJobSteps(WORKFLOW, "ios-xcode-build-sweep");

  test("the job exists and has steps", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  test("the XcodeGen install is backgrounded and carries its id", () => {
    const install = stepNamed(steps, "Install XcodeGen");
    expect(install).toBeDefined();
    expect(install?.background).toBe(true);
    expect(install?.id).toBe("install-xcodegen");
  });

  test("the simulator runtime ensure is hoisted up to overlap the install", () => {
    const installIndex = indexOfNamed(steps, "Install XcodeGen");
    const runtimeIndex = indexOfNamed(steps, "Ensure iOS Simulator runtime");
    const generateIndex = indexOfNamed(steps, "Generate Xcode Projects");

    expect(installIndex).toBeGreaterThanOrEqual(0);
    expect(runtimeIndex).toBeGreaterThanOrEqual(0);
    expect(generateIndex).toBeGreaterThanOrEqual(0);

    expect(installIndex).toBeLessThan(runtimeIndex);
    expect(runtimeIndex).toBeLessThan(generateIndex);
  });

  test("the barrier precedes Generate Xcode Projects, not just the build", () => {
    // Load-bearing: xcodegen-generate.sh AND xcode-build.sh each re-invoke
    // install-xcodegen.sh. Waiting only before `Build Xcode Projects` would
    // still let the generate step race the backgrounded install.
    const waitIndex = indexOfWaitOn(steps, "install-xcodegen");
    const generateIndex = indexOfNamed(steps, "Generate Xcode Projects");
    const buildIndex = indexOfNamed(steps, "Build Xcode Projects");

    expect(waitIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeLessThan(generateIndex);
    expect(generateIndex).toBeLessThan(buildIndex);
  });
});

describe("nightly XCTestRunner Thread Sanitizer lane", () => {
  const jobId = "xctestrunner-tsan";
  const workflow = loadWorkflow(WORKFLOW);
  const job = workflow.jobs?.[jobId];
  const steps = loadJobSteps(WORKFLOW, jobId);

  test("is an independent advisory macOS job with a bounded budget", () => {
    expect(job).toHaveProperty("continue-on-error", true);
    expect(job?.["runs-on"]).toBe("macos-26");
    expect(job?.["timeout-minutes"]).toBe(45);
    expect(job?.needs).toBeUndefined();
    for (const other of Object.values(workflow.jobs ?? {})) {
      const needs = other?.needs;
      expect(Array.isArray(needs) ? needs : needs ? [needs] : []).not.toContain(jobId);
    }
    for (const file of ["pull_request.yml", "merge.yml"]) {
      expect(loadWorkflow(`.github/workflows/${file}`).jobs?.[jobId]).toBeUndefined();
    }
  });

  test("selects Xcode 26.5 and runs the diagnostic before the job deadline", () => {
    const xcode = stepNamed(steps, "Select Xcode 26.5");
    expect(xcode?.uses).toBe("maxim-lobanov/setup-xcode@v1");
    expect(xcode?.with?.["xcode-version"]).toBe("26.5");
    const run = stepNamed(steps, "Run XCTestRunner Thread Sanitizer");
    expect(run?.run).toBe("bash scripts/ci/xctestrunner-tsan.sh");
    const timeout = Number(run?.env?.XCTESTRUNNER_TSAN_TIMEOUT_SECONDS);
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThan((job?.["timeout-minutes"] ?? 0) * 60);
  });

  test("always uploads logs and contains no simulator or daemon steps", () => {
    const upload = stepNamed(steps, "Upload XCTestRunner Thread Sanitizer logs");
    expect(upload?.uses).toBe("actions/upload-artifact@v6");
    expect(upload?.if).toBe("always()");
    expect(upload?.with?.path).toBe("scratch/xctestrunner-tsan/");
    for (const step of steps) {
      expect(step.run ?? "").not.toMatch(/simctl|boot-device|ensure-ios-simulator-runtime|daemon/i);
      expect(step.uses ?? "").not.toContain("ensure-ios-simulator-runtime");
    }
  });
});

describe("nightly unit diagnostics", () => {
  test("always uploads partial shard timings and JUnit reports after failure or timeout", () => {
    const upload = stepNamed(
      loadJobSteps(WORKFLOW, "macos-node-unit-tests"),
      "Upload unit test diagnostics",
    );
    expect(upload?.uses).toBe("actions/upload-artifact@v6");
    expect(upload?.if).toBe("always()");
    expect(upload?.with?.name).toBe("node-unit-test-diagnostics-${{ runner.os }}");
    expect(String(upload?.with?.path).trim().split("\n")).toEqual([
      "scratch/test-ts-unit-shards/**",
      "scratch/timing-unit-reports/**",
    ]);
    expect(upload?.with?.["if-no-files-found"]).toBe("ignore");
    expect(upload?.with?.["retention-days"]).toBe(7);
  });

  test("uses all three macOS cores for the complete unit lane", () => {
    const step = stepNamed(
      loadJobSteps(WORKFLOW, "macos-node-unit-tests"),
      "Run complete unit lane",
    );
    expect(step?.env?.AUTOMOBILE_UNIT_TEST_WORKERS).toBe("3");
    expect(step?.run).toContain("bash scripts/test-ts.sh unit");
  });

  test("keeps the race guard advisory, standalone and exclusive to nightly", () => {
    const nightly = loadWorkflow(WORKFLOW);
    const guard = nightly.jobs?.["auto-advance-race-guard"];
    expect(guard).toBeDefined();
    expect(guard).toHaveProperty("continue-on-error", true);
    expect(guard?.["runs-on"]).toBe("ubuntu-latest");
    expect(guard?.["timeout-minutes"]).toBe(20);
    expect(guard?.needs).toBeUndefined();
    const steps = loadJobSteps(WORKFLOW, "auto-advance-race-guard");
    expect(stepNamed(steps, "Setup Bun")?.with?.["bun-version"]).toBe("1.3.14");
    expect(stepNamed(steps, "Install Bun dependencies")?.run).toBe(
      "scripts/ci/install-bun-deps.sh",
    );
    expect(stepNamed(steps, "Run auto-advance race guard")?.run).toBe(
      "bash scripts/ci/auto-advance-race-guard.sh",
    );
    for (const job of Object.values(nightly.jobs ?? {})) {
      expect(Array.isArray(job?.needs) ? job.needs : [job?.needs]).not.toContain(
        "auto-advance-race-guard",
      );
    }
    for (const workflow of [".github/workflows/pull_request.yml", ".github/workflows/merge.yml"]) {
      expect(loadWorkflow(workflow).jobs?.["auto-advance-race-guard"]).toBeUndefined();
    }
  });
});

describe("nightly randomized unit diagnostic", () => {
  const jobId = "node-randomized-unit-tests";
  const nightly = loadWorkflow(WORKFLOW);
  const job = nightly.jobs?.[jobId];
  const steps = loadJobSteps(WORKFLOW, jobId);

  test("is bounded, advisory, independent and exclusive to nightly", () => {
    expect(job).toHaveProperty("continue-on-error", true);
    expect(job?.["runs-on"]).toBe("ubuntu-latest");
    expect(job?.["timeout-minutes"]).toBe(15);
    expect(job?.needs).toBeUndefined();
    for (const other of Object.values(nightly.jobs ?? {})) {
      expect(Array.isArray(other?.needs) ? other.needs : [other?.needs]).not.toContain(jobId);
    }
    for (const file of ["pull_request.yml", "merge.yml"]) {
      expect(loadWorkflow(`.github/workflows/${file}`).jobs?.[jobId]).toBeUndefined();
    }
  });

  test("runs the canonical selector with a reproducible run-derived seed", () => {
    expect(stepNamed(steps, "Setup Bun")?.with?.["bun-version"]).toBe("1.3.14");
    expect(stepNamed(steps, "Install Bun dependencies")?.run).toBe(
      "scripts/ci/install-bun-deps.sh",
    );
    const run = stepNamed(steps, "Run randomized unit lane");
    expect(run?.run).toBe("bash scripts/test-ts.sh unit");
    expect(run?.env?.AUTOMOBILE_TEST_MODE).toBe("true");
    expect(run?.env?.AUTOMOBILE_UNIT_RANDOM_SEED).toBe("${{ github.run_number }}");
    expect(Number(run?.env?.AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS)).toBeLessThan(
      (job?.["timeout-minutes"] ?? 0) * 60,
    );
  });
});
