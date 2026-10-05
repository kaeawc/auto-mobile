import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadJobs } from "../helpers/workflowSteps";

const WORKFLOW = ".github/workflows/merge.yml";

// These jobs retain macOS configuration while explicitly disabled. ios-xcode-build
// is blocked by its disabled ios-xcodegen dependency, but lacks its own guard.
const MACOS_EXCEPTIONS = new Set(["build-desktop-app", "ios-xcodegen", "ios-xcode-build"]);

describe("On Merge hosted macOS removal (#8583)", () => {
  test("schedules no hosted macOS runner outside the named dormant jobs", () => {
    const jobs = loadJobs(WORKFLOW);
    const offenders = Object.entries(jobs)
      .filter(([id, job]) => {
        if (MACOS_EXCEPTIONS.has(id)) {
          return false;
        }
        const runsOn = JSON.stringify(job["runs-on"] ?? "");
        const matrix = JSON.stringify(job.strategy?.matrix ?? {});
        return /macos/i.test(runsOn) || /macos-(?:latest|\d+)/i.test(matrix);
      })
      .map(([id]) => id);

    expect(offenders).toEqual([]);
    for (const id of MACOS_EXCEPTIONS) {
      expect(jobs[id], `${id} must remain present`).toBeDefined();
      if (id === "ios-xcode-build") {
        expect(jobs[id]?.needs).toBe("ios-xcodegen");
        expect(jobs["ios-xcodegen"]?.if).toBe("${{ false }}");
      } else {
        expect(jobs[id]?.if).toBe("${{ false }}");
      }
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
