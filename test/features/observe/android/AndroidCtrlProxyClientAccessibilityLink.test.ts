import { describe, expect, spyOn, test } from "bun:test";
import { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import { FakeAdbExecutor } from "../../../fakes/FakeAdbExecutor";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

describe("Android semantic link activation outcomes", () => {
  const createClient = async () => {
    const timer = new FakeTimer();
    const adb = new FakeAdbExecutor();
    adb.setCommandResponse("forward", { stdout: "8765", stderr: "" });
    adb.setScreenState(true);
    let socket!: FakeWebSocket;
    const client = AndroidCtrlProxyClient.createForTesting(
      { deviceId: "semantic-link", platform: "android", name: "Test Device", isEmulator: true },
      adb,
      (url) => (socket = new FakeWebSocket(url, "none", 0, timer)),
      timer,
    );
    await client.ensureConnected();
    socket.simulateMessage(
      JSON.stringify({
        type: "connected",
        supportedCommands: ["request_activate_accessibility_link"],
      }),
    );
    return { client, socket, timer };
  };

  test.each([
    "timeout",
    "transport",
    "refusal",
    "protocol refusal",
    "success",
    "abort after dispatch",
  ])("%s preserves dispatch evidence and cleans the wait", async (mode) => {
    const { client, socket, timer } = await createClient();
    const controller = new AbortController();
    const frames: Array<{ requestId: string }> = [];
    let sent!: () => void;
    const written = new Promise<void>((resolve) => {
      sent = resolve;
    });
    const send = spyOn(socket, "send").mockImplementation((data) => {
      frames.push(JSON.parse(String(data)) as { requestId: string });
      sent();
    });
    let dispatchCount = 0;
    try {
      const pending = client.requestActivateAccessibilityLink(
        "Terms",
        0,
        undefined,
        5000,
        undefined,
        controller.signal,
        () => {
          dispatchCount++;
        },
      );
      await written;
      if (mode === "timeout") {
        timer.advanceTime(5000);
      } else if (mode === "transport") {
        client["requestManager"].cancelAll("WebSocket connection closed");
      } else if (mode === "abort after dispatch") {
        controller.abort(new Error("cancelled"));
        for (let i = 0; i < 30; i++) {
          await Promise.resolve();
        }
        expect(client["requestManager"].getPendingCount()).toBe(0);
        timer.advanceTime(5000);
      } else {
        socket.simulateMessage(
          JSON.stringify({
            type: mode === "protocol refusal" ? "error" : "action_result",
            requestId: frames[0].requestId,
            action: "activate_accessibility_link",
            success: mode === "success",
            totalTimeMs: 1,
            error: "node refused activation",
          }),
        );
      }
      const result = await pending;
      const acknowledged = ["refusal", "protocol refusal", "success"].includes(mode);
      expect(result).toMatchObject({ success: mode === "success", dispatched: true, acknowledged });
      expect(result.retryable).toBe(acknowledged ? undefined : false);
      expect(frames).toHaveLength(1);
      expect(dispatchCount).toBe(1);
      expect(client["requestManager"].getPendingCount()).toBe(0);
      if (mode.includes("refusal")) {
        expect(result.error).toBe("node refused activation");
      }
    } finally {
      send.mockRestore();
      await client.close();
    }
  });

  test("abort after registration but before send rethrows and settles the registration", async () => {
    const { client, socket } = await createClient();
    const controller = new AbortController();
    const reason = new Error("cancelled before send");
    const manager = client["requestManager"];
    const register = manager.register.bind(manager);
    const registration = spyOn(manager, "register").mockImplementation((...args) => {
      const pending = register(...args);
      controller.abort(reason);
      return pending;
    });
    const send = spyOn(socket, "send");
    try {
      const pending = client.requestActivateAccessibilityLink(
        "Terms",
        0,
        undefined,
        5000,
        undefined,
        controller.signal,
      );
      for (let i = 0; i < 30; i++) {
        await Promise.resolve();
      }
      const pendingCount = manager.getPendingCount();
      client["requestManager"].resolveError(manager.getPendingIds()[0], "unfixed request sent");
      await expect(pending).rejects.toBe(reason);
      expect(pendingCount).toBe(0);
      expect(registration).toHaveBeenCalledTimes(1);
      expect(send).not.toHaveBeenCalled();
      expect(manager.getPendingCount()).toBe(0);
    } finally {
      registration.mockRestore();
      send.mockRestore();
      await client.close();
    }
  });
});
