import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { loadJobSteps, loadWorkflow, stepNamed } from "../helpers/workflowSteps";

// Guards the CircleCI macOS lanes (#10887, #11010). CircleCI runs one macOS job
// at a time for this organization, so it carries exactly one PR simulator job
// (Playground), the post-merge macOS work (path-gated and coalesced per merge
// burst) and the nightly macOS work (ordered most valuable first). No pull-request
// workflow may reach a context (CircleCI's only way to hand a build restricted
// secrets).

const repoRoot = join(import.meta.dir, "../..");
const XCTESTRUNNER_WORKFLOW = ".github/workflows/xctestrunner-simulator-tests.yml";
const SETUP = ".circleci/config.yml";
const CONTINUE = ".circleci/continue_config.yml";
const MAIN_MAPPING = ".circleci/main-macos-paths.txt";

type CircleStep = string | Record<string, Record<string, unknown> | undefined>;
type CircleInvocation = string | Record<string, Record<string, unknown> | undefined>;

interface CircleWorkflow {
  when?: unknown;
  jobs?: CircleInvocation[];
}

interface CircleJob {
  environment?: Record<string, string>;
  steps?: CircleStep[];
  docker?: unknown;
}

interface CircleConfig {
  parameters?: Record<string, unknown>;
  executors?: Record<string, { environment?: Record<string, string> }>;
  jobs?: Record<string, CircleJob>;
  workflows?: Record<string, CircleWorkflow>;
}

function loadCircle(path: string): CircleConfig {
  return load(readFileSync(join(repoRoot, path), "utf8")) as CircleConfig;
}

function parseMapping(text: string): Map<string, string[]> {
  const byParam = new Map<string, string[]>();
  for (const line of text.split("\n").filter((entry) => entry.trim() !== "")) {
    const [regex, param, value] = line.trim().split(/\s+/);
    expect(value).toBe("true");
    byParam.set(param!, [...(byParam.get(param!) ?? []), regex!]);
  }
  return byParam;
}

function setupStep(jobId: string): Record<string, unknown> | undefined {
  const steps = loadCircle(SETUP).jobs?.[jobId]?.steps ?? [];
  const step = steps.find(
    (entry) => typeof entry !== "string" && entry["path-filtering/set-parameters"],
  );
  return typeof step === "string" ? undefined : step?.["path-filtering/set-parameters"];
}

function prMapping(): Map<string, string[]> {
  return parseMapping(String(setupStep("detect-ios-changes")?.mapping ?? ""));
}

function mainMapping(): Map<string, string[]> {
  return parseMapping(readFileSync(join(repoRoot, MAIN_MAPPING), "utf8"));
}

/** [job key, invocation options] for every job a workflow schedules. */
function invocations(
  workflow: CircleWorkflow | undefined,
): Array<[string, Record<string, unknown>]> {
  return (workflow?.jobs ?? []).map((invocation) => {
    if (typeof invocation === "string") {
      return [invocation, {}];
    }
    const [key, options] = Object.entries(invocation)[0]!;
    return [key, options ?? {}];
  });
}

function stepKey(step: CircleStep): string {
  return typeof step === "string" ? step : Object.keys(step)[0]!;
}

function runCommand(step: CircleStep): string {
  if (typeof step === "string") {
    return "";
  }
  const run = step.run as unknown;
  if (typeof run === "string") {
    return run;
  }
  return String((run as { command?: string } | undefined)?.command ?? "");
}

function runStep(jobId: string, name: string): Record<string, unknown> | undefined {
  const step = (loadCircle(CONTINUE).jobs?.[jobId]?.steps ?? []).find(
    (entry) =>
      typeof entry !== "string" && (entry.run as { name?: string } | undefined)?.name === name,
  );
  return typeof step === "string" ? undefined : (step?.run as Record<string, unknown>);
}

function onlyTesting(command: string): string[] {
  return [...command.matchAll(/-only-testing:(\S+)/g)].map((match) => match[1]!);
}

const PR_PARAMETERS = ["run-ios"];
const MAIN_PARAMETERS = ["run-main-ios", "run-main-desktop"];
const NIGHTLY_ORDER = [
  "XCTestRunner Simulator Tests",
  "Swift Packages Sweep (Xcode 26.6)",
  "Build Xcode Projects Sweep (Xcode 26.6)",
  "macOS Node Unit Tests",
  "macOS Node Host Integration Tests",
  "macOS BATS Shell Tests",
  "macOS BATS Integration Tests",
  "XCTestRunner Thread Sanitizer",
  "Swift Packages Sweep (Xcode 26.5)",
  "Build Xcode Projects Sweep (Xcode 26.5)",
];

function workflowsGatedBy(parameters: string[]): CircleWorkflow[] {
  return Object.values(loadCircle(CONTINUE).workflows ?? {}).filter((workflow) =>
    parameters.some((parameter) => workflow.when === `<< pipeline.parameters.${parameter} >>`),
  );
}

describe("CircleCI macOS policy (#10887, #11010)", () => {
  test("pull requests schedule only the advisory Playground simulator job", () => {
    const prJobs = workflowsGatedBy(PR_PARAMETERS).flatMap((workflow) =>
      invocations(workflow).map(([key]) => key),
    );
    expect(prJobs).toEqual(["ios-playground-tests"]);
    // iOS Device Capture to WHEP moved to a Namespace macOS runner (#11012).
    expect(loadCircle(CONTINUE).jobs?.["ios-device-webrtc"]).toBeUndefined();
    expect(prMapping().has("run-webrtc")).toBe(false);
    // Prototype Simulator moved to the GitHub heavy self-hosted lane (#11011).
    expect(loadCircle(CONTINUE).jobs?.["prototype-simulator"]).toBeUndefined();
    expect(prMapping().has("run-prototype-simulator")).toBe(false);
    const iosWorkflow = loadCircle(CONTINUE).workflows?.["ios-macos"];
    expect(invocations(iosWorkflow).map(([key]) => key)).toEqual(["ios-playground-tests"]);
  });

  test("no CircleCI job mirrors a required GitHub check name", () => {
    const names = Object.values(loadCircle(CONTINUE).workflows ?? {}).flatMap((workflow) =>
      invocations(workflow).map(([key, options]) => String(options.name ?? key)),
    );
    for (const required of [
      "Build Root SPM Package",
      "iOS Build",
      "SwiftLint",
      "Swift Code Coverage",
      "Installer Minimal (macos-latest)",
    ]) {
      expect(names).not.toContain(required);
    }
    for (const removed of ["ios-swift-packages", "ios-xcode-build", "ios-spm-root-package-build"]) {
      const prKeys = workflowsGatedBy(PR_PARAMETERS).flatMap((workflow) =>
        invocations(workflow).map(([key]) => key),
      );
      expect(prKeys).not.toContain(removed);
    }
    expect(loadCircle(CONTINUE).jobs?.["ios-spm-root-package-build"]).toBeUndefined();
  });

  test("post-merge path groups are declared, filtered to main and coalesced", () => {
    const setup = loadCircle(SETUP);
    const continued = loadCircle(CONTINUE);
    expect([...mainMapping().keys()].sort()).toEqual([...MAIN_PARAMETERS].sort());
    for (const regex of [...mainMapping().values()].flat()) {
      // circleci-main-superseded.sh matches with BSD `grep -E`; the orb uses `grep -P`.
      expect(regex).toMatch(/^[\w./\\*^[\]-]+$/);
      expect(regex).not.toMatch(/\\[dswDSW]|\(\?/);
    }
    expect(setupStep("detect-main-macos-changes")?.mapping).toBe(MAIN_MAPPING);
    const detect = setup.workflows?.["detect-main-macos-changes"];
    expect(JSON.stringify(detect?.when)).toContain("run-swift-coverage-main");
    expect(JSON.stringify(detect?.when)).toContain("run-nightly-macos");
    expect(invocations(detect)[0]?.[1]).toEqual({ filters: { branches: { only: "main" } } });

    for (const parameter of MAIN_PARAMETERS) {
      expect(continued.parameters?.[parameter]).toEqual({ type: "boolean", default: false });
      const workflows = workflowsGatedBy([parameter]);
      expect(workflows.length).toBe(1);
      for (const [key, options] of invocations(workflows[0])) {
        expect(options.filters).toEqual({ branches: { only: "main" } });
        const steps = continued.jobs?.[key]?.steps ?? [];
        const guard = steps.find((step) =>
          JSON.stringify(step).includes("halt_if_superseded_on_main"),
        );
        expect(guard, `${key} must halt when superseded`).toBeDefined();
        const group =
          options["superseded-path-group"] ??
          (typeof guard === "string"
            ? undefined
            : guard?.halt_if_superseded_on_main?.["path-group"]);
        expect(group).toBe(parameter);
        expect(steps.indexOf(guard!)).toBe(1);
      }
    }
  });

  test("the superseded check halts the job only on a clean exit", () => {
    const halt = (
      load(readFileSync(join(repoRoot, CONTINUE), "utf8")) as {
        commands?: Record<string, { steps?: CircleStep[] }>;
      }
    ).commands?.halt_if_superseded_on_main?.steps?.[0];
    const command = runCommand(halt!);
    expect(command).toContain(
      'if bash scripts/ci/circleci-main-superseded.sh "<< parameters.path-group >>"; then',
    );
    expect(command).toContain("circleci-agent step halt");
  });

  test("nightly runs once from a scheduled pipeline, most valuable job first", () => {
    const setup = loadCircle(SETUP);
    expect(setup.parameters?.["run-nightly-macos"]).toEqual({ type: "boolean", default: false });
    expect(setup.workflows?.["nightly-macos"]?.when).toBe(
      "<< pipeline.parameters.run-nightly-macos >>",
    );

    const nightly = loadCircle(CONTINUE).workflows?.["nightly-macos"];
    expect(nightly?.when).toBe("<< pipeline.parameters.run-nightly-macos >>");
    const scheduled = invocations(nightly);
    expect(scheduled.map(([, options]) => options.name)).toEqual(NIGHTLY_ORDER);
    expect(scheduled[0]?.[1].requires).toBeUndefined();
    scheduled.slice(1).forEach(([, options], index) => {
      expect(options.requires).toEqual([{ [NIGHTLY_ORDER[index]!]: "terminal" }]);
    });
  });

  test("nightly.yml and merge.yml schedule no GitHub-hosted macOS job", () => {
    for (const path of [".github/workflows/nightly.yml", ".github/workflows/merge.yml"]) {
      const jobs = loadWorkflow(path).jobs ?? {};
      const offenders = Object.entries(jobs)
        .filter(([, job]) =>
          /macos/i.test(JSON.stringify([job?.["runs-on"] ?? "", job?.strategy?.matrix ?? {}])),
        )
        .map(([id]) => id);
      expect(offenders, path).toEqual([]);
    }
  });

  test("nightly XCTestRunner Simulator Tests runs the same tests and daemon budget as the PR opt-in workflow", () => {
    const githubSteps = loadJobSteps(XCTESTRUNNER_WORKFLOW, "ios-xctest-runner-simulator-tests");
    for (const name of [
      "Run selected CtrlProxy iOS tests (Xcode 26.5)",
      "Run odd-width CtrlProxy screenshot test (iPhone 15)",
    ]) {
      const github = onlyTesting(stepNamed(githubSteps, name)?.run ?? "");
      expect(github.length).toBeGreaterThan(0);
      expect(
        onlyTesting(String(runStep("xctestrunner-simulator-tests", name)?.command ?? "")),
      ).toEqual(github);
    }
    const githubEnv = {
      ...(loadWorkflow(XCTESTRUNNER_WORKFLOW).jobs?.["ios-xctest-runner-simulator-tests"]?.env ??
        {}),
    } as Record<string, unknown>;
    delete githubEnv.AUTOMOBILE_LOG_DIR;
    expect(loadCircle(CONTINUE).jobs?.["xctestrunner-simulator-tests"]?.environment).toEqual(
      githubEnv as Record<string, string>,
    );
    // Not re-added to the PR path (#10895): only the nightly workflow schedules it.
    for (const [name, workflow] of Object.entries(loadCircle(CONTINUE).workflows ?? {})) {
      const keys = invocations(workflow).map(([key]) => key);
      expect(keys.includes("xctestrunner-simulator-tests"), name).toBe(name === "nightly-macos");
    }
    expect(prMapping().has("run-ios-integration")).toBe(false);
  });

  test("nightly Thread Sanitizer stays simulator-free and bounded", () => {
    const steps = loadCircle(CONTINUE).jobs?.["xctestrunner-tsan"]?.steps ?? [];
    const run = runStep("xctestrunner-tsan", "Run XCTestRunner Thread Sanitizer");
    expect(run?.command).toBe("bash scripts/ci/xctestrunner-tsan.sh");
    const timeout = Number(
      (run?.environment as Record<string, string>).XCTESTRUNNER_TSAN_TIMEOUT_SECONDS,
    );
    expect(timeout).toBeGreaterThan(0);
    expect(timeout).toBeLessThan(Number.parseInt(String(run?.no_output_timeout), 10) * 60);
    expect(steps.some((step) => stepKey(step) === "store_artifacts")).toBe(true);
    for (const step of steps) {
      expect(runCommand(step)).not.toMatch(/simctl|boot-device|ensure-simulator-runtime|daemon/i);
    }
  });

  test("nightly macOS unit lane keeps one core free and uploads its diagnostics", () => {
    const run = runStep("macos-node-unit-tests", "Run complete unit lane");
    expect(run?.command).toBe("bash scripts/test-ts.sh unit");
    expect(run?.environment).toMatchObject({
      AUTOMOBILE_UNIT_TEST_WORKERS: "2",
      AUTOMOBILE_UNIT_TEST_CHUNK_FILES: "100",
      AUTOMOBILE_TEST_WALL_TIMEOUT_SECONDS: "720",
    });
    const artifacts = (loadCircle(CONTINUE).jobs?.["macos-node-unit-tests"]?.steps ?? [])
      .filter((step) => stepKey(step) === "store_artifacts")
      .map((step) => (typeof step === "string" ? "" : String(step.store_artifacts?.path)));
    expect(artifacts).toEqual(["scratch/test-ts-unit-shards", "scratch/timing-unit-reports"]);
  });

  test("no CircleCI workflow attaches a context and the macOS executor pins signing off", () => {
    for (const path of [SETUP, CONTINUE]) {
      const config = loadCircle(path);
      const withContext = Object.entries(config.workflows ?? {}).flatMap(([name, workflow]) =>
        invocations(workflow)
          .filter(([, options]) => "context" in options)
          .map(() => `${path}:${name}`),
      );
      expect(withContext).toEqual([]);
    }
    const environment = loadCircle(CONTINUE).executors?.ios?.environment;
    expect(environment?.IOS_SIGNING_ENABLED).toBe("false");
    expect(environment?.MACOS_SIGNING_ENABLED).toBe("false");
  });
});
