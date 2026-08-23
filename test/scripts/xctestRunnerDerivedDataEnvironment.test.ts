import { describe, expect, test } from "bun:test";
import { indexOfNamed, loadJobs, loadJobSteps, stepNamed } from "../helpers/workflowSteps";

const WORKFLOW = ".github/workflows/pull_request.yml";
const JOB_ID = "ios-xctest-runner-simulator-tests";
const SOURCE_BUILT_DERIVED_DATA = "/tmp/automobile-ctrl-proxy";

describe("#4966 XCTestRunner source-built CtrlProxy artifacts", () => {
  test("pins the build script and restarted daemons to the same derived-data path", () => {
    const job = loadJobs(WORKFLOW)[JOB_ID];

    expect(job).toBeDefined();
    expect(job?.env?.AUTOMOBILE_CTRL_PROXY_IOS_DERIVED_DATA).toBe(SOURCE_BUILT_DERIVED_DATA);
    expect(job?.env?.AUTOMOBILE_SKIP_CTRL_PROXY_DOWNLOAD).toBe("true");
  });

  test("pins the source-built runner checksum before daemon startup", () => {
    const steps = loadJobSteps(WORKFLOW, JOB_ID);
    const pinIntegrity = stepNamed(steps, "Pin Source-Built CtrlProxy Runner Integrity");

    expect(pinIntegrity?.run).toContain("CtrlProxyUITests.xctest/CtrlProxyUITests");
    expect(pinIntegrity?.run).toContain("shasum -a 256");
    expect(pinIntegrity?.run).toContain("AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256");
    expect(pinIntegrity?.run).toContain("AUTOMOBILE_CTRL_PROXY_IOS_RUNNER_SHA256_TARGET=xctest");
    expect(indexOfNamed(steps, "Build CtrlProxy iOS for Testing")).toBeLessThan(
      indexOfNamed(steps, "Pin Source-Built CtrlProxy Runner Integrity"),
    );
    expect(indexOfNamed(steps, "Pin Source-Built CtrlProxy Runner Integrity")).toBeLessThan(
      indexOfNamed(steps, "Ensure AutoMobile daemon ready (Xcode 26.5)"),
    );
  });
});
