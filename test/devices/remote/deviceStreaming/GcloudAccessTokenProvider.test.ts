import { describe, expect, test } from "bun:test";
import {
  GCLOUD_TOKEN_REUSE_MS,
  GcloudAccessTokenProvider,
} from "../../../../src/devices/remote/deviceStreaming/GcloudAccessTokenProvider";
import { createExecResult } from "../../../../src/utils/execResult";
import { FakeHostCommandExecutor } from "../../../fakes/FakeHostCommandExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";

function setup(stdout = "ya29.token-1\n") {
  const host = new FakeHostCommandExecutor();
  host.setCommandResponse("auth print-access-token", createExecResult(stdout, ""));
  const timer = new FakeTimer();
  const tokens = new GcloudAccessTokenProvider({ host, timer });
  return { host, timer, tokens };
}

describe("GcloudAccessTokenProvider", () => {
  test("prints the active account's token through gcloud with a bounded timeout", async () => {
    const { host, tokens } = setup();

    expect(await tokens.accessToken()).toBe("ya29.token-1");
    expect(host.getExecutedCalls()).toEqual([
      { command: "gcloud", args: ["auth", "print-access-token"], options: { timeoutMs: 30_000 } },
    ]);
  });

  test("reuses a token until the reuse window passes, then fetches a new one", async () => {
    const { host, timer, tokens } = setup();
    await tokens.accessToken();
    timer.setCurrentTime(GCLOUD_TOKEN_REUSE_MS - 1);
    await tokens.accessToken();
    expect(host.getExecutedCommands()).toHaveLength(1);

    host.setCommandResponse("auth print-access-token", createExecResult("ya29.token-2", ""));
    timer.setCurrentTime(GCLOUD_TOKEN_REUSE_MS);

    expect(await tokens.accessToken()).toBe("ya29.token-2");
    expect(host.getExecutedCommands()).toHaveLength(2);
  });

  test("concurrent callers share one gcloud run", async () => {
    const { host, tokens } = setup();

    const [first, second] = await Promise.all([tokens.accessToken(), tokens.accessToken()]);

    expect([first, second]).toEqual(["ya29.token-1", "ya29.token-1"]);
    expect(host.getExecutedCommands()).toHaveLength(1);
  });

  test("a gcloud failure says how to sign in and is not cached", async () => {
    const { host, tokens } = setup();
    host.setCommandError("auth print-access-token", new Error("command not found: gcloud"));

    await expect(tokens.accessToken()).rejects.toThrow(
      "Could not get a Google Cloud access token; install the Google Cloud CLI and run " +
        "`gcloud auth login`: command not found: gcloud",
    );
    await expect(tokens.accessToken()).rejects.toThrow("command not found: gcloud");
    expect(host.getExecutedCommands()).toHaveLength(2);
  });

  test("output that is not a single token is rejected", async () => {
    for (const stdout of ["", "ERROR: (gcloud.auth) no credentialed accounts"]) {
      const { tokens } = setup(stdout);
      await expect(tokens.accessToken()).rejects.toThrow("did not print a single access token");
    }
  });
});
