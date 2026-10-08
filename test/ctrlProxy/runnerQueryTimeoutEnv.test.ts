import { describe, expect, test } from "bun:test";
import {
  RUNNER_QUERY_TIMEOUT_ENV,
  runnerQueryTimeoutEnv,
} from "../../src/ctrlProxy/ios/runnerQueryTimeoutEnv";

describe("runnerQueryTimeoutEnv", () => {
  test("adds nothing when the daemon has no override", () => {
    expect(runnerQueryTimeoutEnv({})).toEqual({});
    expect(runnerQueryTimeoutEnv({ [RUNNER_QUERY_TIMEOUT_ENV]: "  " })).toEqual({});
  });

  test("forwards a set override to the runner, trimmed", () => {
    expect(runnerQueryTimeoutEnv({ [RUNNER_QUERY_TIMEOUT_ENV]: " 5 " })).toEqual({
      CTRL_PROXY_IOS_QUERY_TIMEOUT: "5",
    });
    expect(runnerQueryTimeoutEnv({ [RUNNER_QUERY_TIMEOUT_ENV]: "off" })).toEqual({
      CTRL_PROXY_IOS_QUERY_TIMEOUT: "off",
    });
  });
});
