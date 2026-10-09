import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadJobs, loadJobSteps, stepNamed } from "../helpers/workflowSteps";

const androidFix = "cd android && ./gradlew :auto-mobile-sdk:apiDump";
const iosFix = "scripts/ios/api-dump.sh > ios/auto-mobile-sdk/api/auto-mobile-sdk.api";
const build = readFileSync(
  join(import.meta.dir, "../../android/auto-mobile-sdk/build.gradle.kts"),
  "utf8",
);

for (const workflow of ["pull_request", "merge"]) {
  const path = `.github/workflows/${workflow}.yml`;
  const jobs = loadJobs(path);
  // The PR lane folded the SDK consumer check into the compile-smoke job to save
  // a runner slot; merge.yml still runs it as its own job.
  const sdkJob =
    workflow === "pull_request" ? "android-emulator-compile-smoke" : "sdk-debug-inspector-consumer";
  const androidSteps = loadJobSteps(path, sdkJob);
  const isSdkStep = (step: { uses?: string; with?: Record<string, unknown> }): boolean =>
    step.uses === "./.github/actions/gradle-task-run" &&
    String(step.with?.["gradle-tasks"]).includes(":auto-mobile-sdk:apiCheck");

  describe(`${workflow} SDK API baseline`, () => {
    test("checks Android while publishing release classes on the existing hosted runner", () => {
      const step = androidSteps.find(isSdkStep);
      expect(step?.with?.["gradle-tasks"]).toContain(":auto-mobile-sdk:apiCheck");
      expect(step?.with?.["gradle-tasks"]).toContain(":auto-mobile-sdk:publishToMavenLocal");
      expect(step?.with?.["reuse-configuration-cache"]).toBe(true);
      expect(jobs[sdkJob]?.["runs-on"]).toBe("ubuntu-latest");
      if (workflow === "pull_request") {
        expect(jobs[sdkJob]?.if).toContain("android_should_run");
      }
    });

    test("keeps the configuration-cache artifact name unique across jobs", () => {
      const sanitize = (tasks: string): string =>
        tasks
          .replace(/[^a-zA-Z0-9_-]/g, "-")
          .replace(/-+/g, "-")
          .replace(/^-|-$/g, "")
          .slice(0, 64)
          .replace(/-$/, "");
      const sdkStep = androidSteps.find(isSdkStep);
      const sdkName = sanitize(String(sdkStep?.with?.["gradle-tasks"]));
      expect(sdkName).toContain("auto-mobile-sdk-apiCheck");
      for (const [jobId, job] of Object.entries(jobs)) {
        for (const step of job.steps ?? []) {
          if (step.uses === "./.github/actions/gradle-task-run" && !isSdkStep(step)) {
            expect(sanitize(String(step.with?.["gradle-tasks"]))).not.toBe(sdkName);
          }
        }
      }
    });

    if (workflow === "pull_request") {
      const iosSteps = loadJobSteps(path, "ios-swift-packages");
      test("checks iOS after resolving dependencies and before building, with a repair command", () => {
        const step = stepNamed(iosSteps, "Check iOS SDK public API baseline");
        expect(step?.run).toContain("scripts/ios/api-dump.sh --check");
        expect(step?.run).toContain(`::error::Update the iOS SDK API baseline: ${iosFix}`);
        expect(step?.run).toContain("exit 1");
        const index = iosSteps.indexOf(step!);
        expect(index).toBeGreaterThan(
          iosSteps.findIndex(
            (candidate) => candidate.name === "Resolve Swift package dependencies",
          ),
        );
        const buildIndex = iosSteps.findIndex(
          (candidate) => candidate.name === "Build Swift Packages",
        );
        expect(buildIndex).toBeGreaterThan(index);
        expect(jobs["ios-swift-packages"]?.if).toContain("ios_should_run");
      });
    }
  });
}

test("Android API actions use typed task properties and name the local repair command", () => {
  expect(build).toContain('tasks.register<SdkApiDumpTask>("apiDump")');
  expect(build).toContain('tasks.register<SdkApiCheckTask>("apiCheck")');
  expect(build).toContain("abstract class SdkApiSignatureTask : DefaultTask()");
  expect(build).toContain("@TaskAction");
  expect(build).toContain("@get:InputFiles");
  expect(build).toContain("@get:OutputFile");
  expect(build).toContain(androidFix);
  expect(build).not.toContain("doLast");
  expect(build).not.toContain("generateApiSignature(files(");
  expect(build).not.toContain("relativeTo(projectDir)");
});
