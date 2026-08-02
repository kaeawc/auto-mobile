import { describe, expect, test } from "bun:test";
import { loadJobs } from "../helpers/workflowSteps";

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
});
