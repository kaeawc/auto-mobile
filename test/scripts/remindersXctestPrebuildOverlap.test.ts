import { describe, expect, test } from "bun:test";
import { indexOfNamed, indexOfWaitOn, loadJobSteps, stepNamed } from "../helpers/workflowSteps";

// Guards #4131: compiling XCTestRunner tests is CPU-bound, while daemon and
// CtrlProxy readiness are mostly wait-bound. Start the prebuild before those
// warm-ups, then join it immediately before warming the Reminders target app:
// `swift test` must never recompile after that final warm-up.
const WORKFLOW = ".github/workflows/pull_request.yml";
const JOB_ID = "ios-xctest-runner-simulator-tests";
const PREBUILD_STEP = "Pre-build Reminders XCTest bundle (Xcode 26.5)";
const DAEMON_STEP = "Ensure AutoMobile daemon ready (Xcode 26.5)";
const CTRL_PROXY_STEP = "Warm up iOS CtrlProxy (Xcode 26.5)";
const REMINDERS_WARMUP_STEP = "Warm up Reminders target app (Xcode 26.5)";
const PREBUILD_ID = "prebuild-xctest";

const steps = loadJobSteps(WORKFLOW, JOB_ID);

describe("#4131 Reminders XCTest prebuild overlap", () => {
  test("the XCTestRunner job exists and has steps", () => {
    expect(steps.length).toBeGreaterThan(0);
  });

  test("the prebuild is backgrounded with a stable id", () => {
    const prebuild = stepNamed(steps, PREBUILD_STEP);

    expect(prebuild).toBeDefined();
    expect(prebuild?.background).toBe(true);
    expect(prebuild?.id).toBe(PREBUILD_ID);
  });

  test("the prebuild overlaps daemon and CtrlProxy warm-up", () => {
    const prebuildIndex = indexOfNamed(steps, PREBUILD_STEP);
    const daemonIndex = indexOfNamed(steps, DAEMON_STEP);
    const ctrlProxyIndex = indexOfNamed(steps, CTRL_PROXY_STEP);

    expect(prebuildIndex).toBeGreaterThanOrEqual(0);
    expect(daemonIndex).toBeGreaterThanOrEqual(0);
    expect(ctrlProxyIndex).toBeGreaterThanOrEqual(0);
    expect(prebuildIndex).toBeLessThan(daemonIndex);
    expect(daemonIndex).toBeLessThan(ctrlProxyIndex);
  });

  test("the prebuild barrier immediately precedes Reminders warm-up", () => {
    const ctrlProxyIndex = indexOfNamed(steps, CTRL_PROXY_STEP);
    const waitIndex = indexOfWaitOn(steps, PREBUILD_ID);
    const warmupIndex = indexOfNamed(steps, REMINDERS_WARMUP_STEP);

    expect(ctrlProxyIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBeGreaterThan(ctrlProxyIndex);
    expect(warmupIndex).toBeGreaterThanOrEqual(0);
    expect(waitIndex).toBe(warmupIndex - 1);
  });
});
