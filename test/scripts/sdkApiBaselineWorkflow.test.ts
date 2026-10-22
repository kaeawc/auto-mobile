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
const prototypeBuild = readFileSync(
  join(import.meta.dir, "../../android/prototype-compose/build.gradle.kts"),
  "utf8",
);
const tasks = readFileSync(
  join(
    import.meta.dir,
    "../../android/build-logic/src/main/kotlin/dev/jasonpearson/automobile/buildlogic/apisignature/ApiSignatureTasks.kt",
  ),
  "utf8",
);

for (const workflow of ["pull_request", "merge"]) {
  const path = `.github/workflows/${workflow}.yml`;
  const jobs = loadJobs(path);
  // The PR lane runs the SDK consumer check inside JVM Consumer Checks to save a
  // runner slot (#10890, #10894); merge.yml still runs it as its own job.
  const sdkJob =
    workflow === "pull_request" ? "jvm-consumer-checks" : "sdk-debug-inspector-consumer";
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
      for (const job of Object.values(jobs)) {
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
  // The task classes are shared from build-logic (#13727); each library only registers them.
  for (const [module, file] of [
    [":auto-mobile-sdk", build],
    [":prototype-compose", prototypeBuild],
  ] as const) {
    expect(file).toContain('tasks.register<ApiSignatureDumpTask>("apiDump")');
    expect(file).toContain('tasks.register<ApiSignatureCheckTask>("apiCheck")');
    expect(file).toContain(`dumpCommand.set("cd android && ./gradlew ${module}:apiDump")`);
    expect(file).not.toContain("generateApiSignature(files(");
  }
  expect(build).toContain(androidFix);
  expect(tasks).toContain("abstract class ApiSignatureTask : DefaultTask()");
  expect(tasks).toContain("@TaskAction");
  expect(tasks).toContain("@get:InputFiles");
  expect(tasks).toContain("@get:OutputFile");
  expect(tasks).toContain("Run $command first.");
  expect(tasks).not.toContain("doLast");
  expect(tasks).not.toContain("relativeTo(projectDir)");
});
