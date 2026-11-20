import { describe, expect, test } from "bun:test";
import {
  ConnectionLivenessMonitor,
  type ConnectionLivenessHost,
} from "../../../src/features/observe/ConnectionLivenessMonitor";
import {
  beginCapturedCommand,
  runWithFixtureCapture,
} from "../../../src/utils/fixtureCapture/fixtureCaptureScope";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("ConnectionLivenessMonitor fixture capture", () => {
  test("a reconnect after a failed health check is not attributed to the call that connected", async () => {
    const timer = new FakeTimer();
    let seenByReconnect: ReturnType<typeof beginCapturedCommand> | "unset" = "unset";
    const host: ConnectionLivenessHost = {
      timer,
      healthCheckIntervalMs: 1000,
      healthCheckIntervalId: null,
      lastHealthCheckTime: 0,
      getLogTag: () => "test",
      getSocket: () => null,
      reconnectAfterFailedHealthCheck: () => {
        seenByReconnect = beginCapturedCommand(["adb", "forward"]);
      },
      silentTimeoutConfirmationMs: () => undefined,
      onConfirmedRequestStall: () => {},
    };
    const monitor = new ConnectionLivenessMonitor(host);

    // The health check starts inside a live tool call, so its interval inherits that call's scope.
    await runWithFixtureCapture(
      "observe",
      {
        writer: { write: async () => {} },
        timer,
        sourceIdentity: async () => ({ automobileVersion: "0", sourceTreeState: "clean" }),
      },
      async () => {
        monitor.startHealthCheck();
        timer.advanceTime(1000);
      },
    );

    expect(seenByReconnect).toBeUndefined();
  });
});
