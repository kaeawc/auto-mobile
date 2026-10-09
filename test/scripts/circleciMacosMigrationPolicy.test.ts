import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { load } from "js-yaml";
import { loadJobSteps, stepNamed } from "../helpers/workflowSteps";

// Guards the CircleCI macOS mirrors added for #10887: the CircleCI path filters
// must stay identical to the GitHub filters that gate the mirrored jobs, the
// mirrors must keep their GitHub job names, and no pull-request workflow may
// reach a context (CircleCI's only way to hand a build restricted secrets).

const repoRoot = join(import.meta.dir, "../..");
const PR_WORKFLOW = ".github/workflows/pull_request.yml";

interface CircleWorkflow {
  when?: string;
  jobs?: Array<string | Record<string, Record<string, unknown>>>;
}

interface CircleConfig {
  executors?: Record<string, { environment?: Record<string, string> }>;
  jobs?: Record<string, { steps?: Array<string | Record<string, Record<string, unknown>>> }>;
  workflows?: Record<string, CircleWorkflow>;
}

function loadCircle(path: string): CircleConfig {
  return load(readFileSync(join(repoRoot, path), "utf8")) as CircleConfig;
}

/** Converts a dorny/paths-filter (picomatch) glob into the anchored-PCRE body the
 * path-filtering orb wraps as `^<regex>$`. Only the glob forms the mirrored
 * filters use are supported; anything else fails loudly. */
function globToOrbRegex(glob: string): string {
  if (/[?[\]{}!]/.test(glob)) {
    throw new Error(`unsupported glob syntax: ${glob}`);
  }
  return glob
    .replace(/\./g, "\\.")
    .replace(/\*\*\//g, "\u0000")
    .replace(/\/\*\*$/, "/\u0001")
    .replace(/\*/g, "[^/]*")
    .replace(/\u0000/g, "(.*/)?")
    .replace(/\u0001/g, ".*");
}

function githubFilterGlobs(stepName: string, key: string): string[] {
  const step = stepNamed(loadJobSteps(PR_WORKFLOW, "detect-changes"), stepName);
  const filters = load(String(step?.with?.filters ?? "")) as Record<string, string[]>;
  const globs = filters[key];
  if (!globs) {
    throw new Error(`${stepName} has no ${key} filter`);
  }
  return globs;
}

function setupMapping(): Map<string, string[]> {
  const config = loadCircle(".circleci/config.yml") as {
    jobs?: Record<string, { steps?: Array<Record<string, { mapping?: string }>> }>;
  };
  const steps = config.jobs?.["detect-ios-changes"]?.steps ?? [];
  const mapping = steps.find((step) => step["path-filtering/set-parameters"])?.[
    "path-filtering/set-parameters"
  ]?.mapping;
  const byParam = new Map<string, string[]>();
  for (const line of (mapping ?? "").split("\n").filter((entry) => entry.trim() !== "")) {
    const [regex, param, value] = line.trim().split(/\s+/);
    expect(value).toBe("true");
    byParam.set(param!, [...(byParam.get(param!) ?? []), regex!]);
  }
  return byParam;
}

const CIRCLE_CONFIG_SELF_TRIGGER = "\\.circleci/continue_config\\.yml";

describe("CircleCI macOS migration policy (#10887)", () => {
  test("globToOrbRegex covers the glob forms the filters use", () => {
    expect(globToOrbRegex("schemas/**")).toBe("schemas/.*");
    expect(globToOrbRegex("src/index.ts")).toBe("src/index\\.ts");
    expect(globToOrbRegex("src/utils/Ios*")).toBe("src/utils/Ios[^/]*");
    expect(globToOrbRegex("src/utils/ios-*/**")).toBe("src/utils/ios-[^/]*/.*");
    expect(globToOrbRegex("src/features/**/web/**")).toBe("src/features/(.*/)?web/.*");
    expect(globToOrbRegex("src/daemon/webrtc*")).toBe("src/daemon/webrtc[^/]*");
    expect(() => globToOrbRegex("src/{a,b}.ts")).toThrow("unsupported glob syntax");
  });

  test.each([
    ["run-ios-integration", "Check for native-integration-affecting changes", "native_integration"],
    ["run-webrtc", "Check for WebRTC publisher changes", "webrtc"],
  ])("%s mapping mirrors the GitHub %s filter", (param, stepName, key) => {
    const expected = [
      ...githubFilterGlobs(stepName, key).map(globToOrbRegex),
      CIRCLE_CONFIG_SELF_TRIGGER,
    ];
    expect(setupMapping().get(param)).toEqual(expected);
  });

  test("mirrored jobs keep their GitHub job names", () => {
    const workflows = loadCircle(".circleci/continue_config.yml").workflows ?? {};
    const names = Object.values(workflows).flatMap((workflow) =>
      (workflow.jobs ?? []).flatMap((invocation) =>
        typeof invocation === "string"
          ? []
          : Object.values(invocation).map((options) => options?.name),
      ),
    );
    for (const name of [
      "XCTestRunner Simulator Tests",
      "Build Root SPM Package",
      "iOS Device Capture to WHEP",
    ]) {
      expect(names).toContain(name);
    }
  });

  test("no CircleCI workflow attaches a context and the macOS executor pins signing off", () => {
    for (const path of [".circleci/config.yml", ".circleci/continue_config.yml"]) {
      const config = loadCircle(path);
      const withContext = Object.entries(config.workflows ?? {}).flatMap(([name, workflow]) =>
        (workflow.jobs ?? [])
          .filter(
            (invocation) =>
              typeof invocation !== "string" &&
              Object.values(invocation).some((options) => options && "context" in options),
          )
          .map(() => `${path}:${name}`),
      );
      expect(withContext).toEqual([]);
    }
    const environment = loadCircle(".circleci/continue_config.yml").executors?.ios?.environment;
    expect(environment?.IOS_SIGNING_ENABLED).toBe("false");
    expect(environment?.MACOS_SIGNING_ENABLED).toBe("false");
  });
});
