import { expect, test } from "bun:test";
import { daemonResponseError } from "../../src/daemon/client/client";
import { DAEMON_SESSION_NOT_FOUND_CODE, type DaemonResponse } from "../../src/daemon/types";

test("failed responses carry only a non-empty daemon instance", () => {
  const response: DaemonResponse = {
    id: "heartbeat",
    type: "mcp_response",
    success: false,
    error: "Session not found: s",
    code: DAEMON_SESSION_NOT_FOUND_CODE,
  };
  expect(daemonResponseError({ ...response, daemonInstance: "daemon-B" })).toMatchObject({
    daemonInstance: "daemon-B",
  });
  for (const daemonInstance of [undefined, ""]) {
    expect(daemonResponseError({ ...response, daemonInstance })).not.toHaveProperty(
      "daemonInstance",
    );
  }
});
