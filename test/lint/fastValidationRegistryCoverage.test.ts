import { beforeAll, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import { join } from "node:path";
import { loadJobSteps, stepNamed } from "../helpers/workflowSteps";

// Every exclusion names the job that checks the real tree. Keep this next to
// the guard so a new registry entry requires an explicit CI coverage decision.
const EXCLUDED_WITH_REASON: Readonly<Record<string, string>> = {
  "ctrl-proxy-xcodegen-drift":
    "PR ios-xcode-build: xcodegen-drift-check.sh --all on macOS (XcodeGen has no Linux build; this entry skips off-host)",
  "node-format": "PR fast-validation Check formatting step: bun run format:check",
  lychee:
    "merge.yml validate-documentation-links: online links; PR fast-validation runs lychee-offline",
  "host-shell-boundary": "PR ts-build-and-test: lint -> check-boundaries.sh (diff ratchet)",
  "git-metadata-boundary": "PR ts-build-and-test: lint -> check-boundaries.sh",
  "ffmpeg-execution-boundary": "PR ts-build-and-test: lint -> check-boundaries.sh",
  "sdkmanager-execution-boundary":
    "PR node-host-integration-tests: sdkManagerExecutionBoundary.integration.test.ts scans src/",
  "archive-extraction-boundary": "PR node-unit-tests: archiveExtractionBoundary.test.ts scans src/",
  "xcodebuild-boundary": "PR ts-build-and-test: lint -> check-boundaries.sh (diff ratchet)",
  "daemon-launcher-boundary": "PR ts-build-and-test: lint -> check-boundaries.sh",
  "process-safety": "PR ts-build-and-test: lint -> check-boundaries.sh",
};

function selectedChecks(run: string): string[] {
  // Parse the shell argument only; loadJobSteps structurally parses the YAML.
  return [...run.matchAll(/(?:^|\s)--only\s+([\w,-]+)/g)].flatMap((match) => match[1].split(","));
}

function coverageGaps(
  registered: readonly string[],
  selected: readonly string[],
  excluded: Readonly<Record<string, string>>,
) {
  return {
    missing: registered.filter((name) => !selected.includes(name) && !(name in excluded)),
    stale: Object.keys(excluded).filter((name) => !registered.includes(name)),
    overlapping: Object.keys(excluded).filter((name) => selected.includes(name)),
    unknown: selected.filter((name) => !registered.includes(name)),
    undocumented: Object.keys(excluded).filter((name) => !excluded[name].trim()),
  };
}

describe("Fast Validation registry coverage", () => {
  let header: string;
  let registered: string[];
  let selected: string[];
  let mainRun: string;
  let mainSelected: string[];
  let offlineSelected: string[];

  beforeAll(() => {
    if (process.platform === "win32") {
      return;
    }

    const listing = execFileSync("bash", ["scripts/all_fast_validate_checks.sh", "--list"], {
      cwd: join(import.meta.dir, "../.."),
      encoding: "utf8",
    });
    const lines = listing.trimEnd().split("\n");
    header = lines[0];
    registered = lines.slice(1).map((line) => line.trim().split(/\s+/)[0]);
    const steps = loadJobSteps(".github/workflows/pull_request.yml", "fast-validation");
    const mainStep = stepNamed(steps, "Run fast validation checks");
    mainRun = mainStep?.run ?? "";
    selected = steps
      .filter((step) => step.run?.includes("all_fast_validate_checks.sh"))
      .flatMap((step) => selectedChecks(step.run ?? ""));
    mainSelected = selectedChecks(mainRun);
    offlineSelected = selectedChecks(stepNamed(steps, "Run offline lychee link check")?.run ?? "");
  });

  test.skipIf(process.platform === "win32")(
    "every registered check is selected in PR CI or has a documented covering job",
    () => {
      expect(header).toBe("Available checks:");
      expect(registered.length).toBeGreaterThan(0);
      expect(new Set(registered).size).toBe(registered.length);
      expect(mainRun).toContain("all_fast_validate_checks.sh");
      expect(coverageGaps(registered, selected, EXCLUDED_WITH_REASON)).toEqual({
        missing: [],
        stale: [],
        overlapping: [],
        unknown: [],
        undocumented: [],
      });
      // Neighbouring contract: offline links remain a separate step, and the
      // existing docs guards stay in the main fan-out.
      expect(mainSelected).toEqual(
        expect.arrayContaining(["docs-assets", "env-var-docs", "lfs-pointers"]),
      );
      // BATS is path-filtered (#10889), so the real-tree scans it used to be
      // the only PR coverage for must run in Fast Validation on every PR.
      expect(mainSelected).toEqual(
        expect.arrayContaining(["debug-tags", "datetime-now-literal", "markdown-bash"]),
      );
      expect(offlineSelected).toEqual(["lychee-offline"]);
    },
  );

  test("the guard rejects new, stale, overlapping and unknown check names", () => {
    expect(
      coverageGaps(["new", "covered"], ["covered", "typo"], {
        covered: "PR lint",
        stale: "PR lint",
      }),
    ).toEqual({
      missing: ["new"],
      stale: ["stale"],
      overlapping: ["covered"],
      unknown: ["typo"],
      undocumented: [],
    });
    expect(coverageGaps(["excluded"], [], { excluded: " " }).undocumented).toEqual(["excluded"]);
  });
});
