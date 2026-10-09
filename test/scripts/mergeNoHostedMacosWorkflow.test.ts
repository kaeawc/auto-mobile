import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadJobs } from "../helpers/workflowSteps";

const WORKFLOW = ".github/workflows/merge.yml";

describe("On Merge hosted macOS removal (#8583, #11010)", () => {
  test("schedules no macOS runner; post-merge macOS work runs on CircleCI", () => {
    const jobs = loadJobs(WORKFLOW);
    const offenders = Object.entries(jobs)
      .filter(([, job]) => {
        const runsOn = JSON.stringify(job["runs-on"] ?? "");
        const matrix = JSON.stringify(job.strategy?.matrix ?? {});
        return /macos/i.test(runsOn) || /macos-(?:latest|\d+)/i.test(matrix);
      })
      .map(([id]) => id);

    expect(offenders).toEqual([]);
    for (const id of ["build-desktop-app", "ios-xcodegen", "ios-xcode-build"]) {
      expect(jobs[id], `${id} moved to CircleCI (#11010)`).toBeUndefined();
    }
  });

  test("keeps the four portable lanes and removes the two macOS-only jobs", () => {
    const jobs = loadJobs(WORKFLOW);
    for (const id of [
      "bats-tests",
      "bats-integration-tests",
      "node-unit-tests",
      "node-host-integration-tests",
    ]) {
      expect(jobs[id], `${id} must remain present`).toBeDefined();
      expect(jobs[id]?.strategy?.matrix?.os).toContain("ubuntu-latest");
      expect(jobs[id]?.strategy?.matrix?.os?.some((os) => /^macos-/i.test(os))).toBe(false);
    }
    for (const id of ["node-unit-tests", "node-host-integration-tests"]) {
      expect(jobs[id]?.strategy?.matrix?.os).toContain("windows-latest");
    }
    expect(jobs["mcp-build-and-test"]).toBeUndefined();
    expect(jobs["ios-device-webrtc"]).toBeUndefined();
    expect(jobs["ios-swift-build"]).toBeUndefined();
    expect(jobs["ios-swift-test"]).toBeUndefined();
  });

  test("has no direct hosted macOS runs-on line", () => {
    const source = readFileSync(join(import.meta.dir, "../..", WORKFLOW), "utf8");
    expect(source).not.toMatch(/^\s*runs-on:\s*['"]?macos-(?:latest|\d+)/im);
  });
});
