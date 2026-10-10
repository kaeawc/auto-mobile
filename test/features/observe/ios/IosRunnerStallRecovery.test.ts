import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { ViewHierarchy } from "../../../../src/features/observe/ViewHierarchy";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import { IosRunnerStalledError } from "../../../../src/features/observe/ios/runnerErrorCodes";
import type { AndroidCtrlProxyClient } from "../../../../src/features/observe/android";
import type { BootedDevice } from "../../../../src/models";
import { freshnessSchema } from "../../../../src/server/toolOutputSchemas";
import { FakeAdbClientFactory } from "../../../fakes/FakeAdbClientFactory";
import { FakeIOSCtrlProxyManager } from "../../../fakes/FakeIOSCtrlProxyManager";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeWebSocket } from "../../../fakes/FakeWebSocket";

const device: BootedDevice = { platform: "ios", deviceId: "stalled-runner", name: "Test iPhone" };
type Command = { type: string; requestId?: string };

describe("iOS stalled command recovery", () => {
  let timer: FakeTimer;
  let manager: FakeIOSCtrlProxyManager;
  let client: IOSCtrlProxyClient;
  let subject: ViewHierarchy;
  let sockets: FakeWebSocket[];
  let commands: Command[];
  let restartCalls: number;
  let restartFails: boolean;
  let stillStalled: boolean;
  let blockingElapsedMs: number;
  let onRequest: (() => void) | undefined;
  let restoreInstance: () => void;

  beforeEach(async () => {
    timer = new FakeTimer();
    timer.enableAutoAdvance();
    manager = new FakeIOSCtrlProxyManager(timer);
    sockets = [];
    commands = [];
    restartCalls = 0;
    restartFails = false;
    stillStalled = false;
    blockingElapsedMs = 61_200;
    onRequest = undefined;
    manager.forceRestart = async () => {
      restartCalls++;
      if (restartFails) {
        throw new Error("runner restart failed");
      }
      // Model the process manager replacing the runner and its old socket.
      sockets.at(-1)?.terminate();
    };
    client = IOSCtrlProxyClient.createForTesting(
      device,
      8765,
      (url) => {
        const socket = new FakeWebSocket(url, "none", 0, timer);
        sockets.push(socket);
        socket.send = (wire) => {
          const command = JSON.parse(String(wire)) as Command;
          if (!command.requestId) {
            return;
          }
          if (command.type === "get_sdk_capabilities") {
            queueMicrotask(() =>
              socket.simulateMessage(
                JSON.stringify({
                  type: "sdk_capabilities_result",
                  requestId: command.requestId,
                  success: true,
                  available: false,
                }),
              ),
            );
            return;
          }
          commands.push(command);
          onRequest?.();
          queueMicrotask(() =>
            socket.simulateMessage(
              JSON.stringify(
                restartCalls > 0 && !stillStalled && !restartFails
                  ? {
                      type: "hierarchy_update",
                      requestId: command.requestId,
                      data: {
                        updatedAt: timer.now(),
                        packageName: "com.example",
                        hierarchy: { role: "text", text: "Recovered" },
                      },
                    }
                  : {
                      type: "error",
                      requestId: command.requestId,
                      success: false,
                      error: "runner_busy",
                      blockingCommandType: "request_activate_accessibility_link",
                      blockingElapsedMs,
                    },
              ),
            ),
          );
        };
        return socket;
      },
      timer,
      () => manager,
    );
    const instanceSpy = spyOn(IOSCtrlProxyClient, "getInstance").mockReturnValue(client);
    restoreInstance = () => instanceSpy.mockRestore();
    subject = new ViewHierarchy(
      device,
      new FakeAdbClientFactory(),
      {} as AndroidCtrlProxyClient,
      timer,
    );
    expect(await client.ensureConnected()).toBe(true);
    // Finish the original socket's stability window before testing recovery.
    await timer.advanceTimeAsync(2000);
    commands.length = 0;
  });

  afterEach(async () => {
    restoreInstance();
    await client.close();
    IOSCtrlProxyClient.resetInstances();
  });

  test("recovers a responsive but blocked runner and only refetches hierarchy", async () => {
    const result = await subject.getViewHierarchy();
    expect(result.hierarchy.error).toBeUndefined();
    expect(restartCalls).toBe(1);
    expect(sockets).toHaveLength(2);
    expect(commands.map((command) => command.type)).toEqual([
      "request_hierarchy",
      "request_hierarchy",
    ]);
  });

  test("returns persistent stall evidence after one recovery, without recursive retries", async () => {
    stillStalled = true;
    const result = await subject.getViewHierarchy();
    expect(restartCalls).toBe(1);
    expect(commands).toHaveLength(2);
    expect(result.hierarchy.unavailableReason).toBe("runner_stalled");
    expect(result.hierarchy.unavailableDetail).toContain("61.2s");
    expect(result.hierarchy.unavailableDetail).toContain("outcome is unknown");
    expect(
      freshnessSchema.safeParse({
        isFresh: false,
        unavailableReason: result.hierarchy.unavailableReason,
        unavailableDetail: result.hierarchy.unavailableDetail,
      }).success,
    ).toBe(true);
  });

  test("does not restart or replay a rejected action", async () => {
    await expect(client.requestPressBack()).rejects.toBeInstanceOf(IosRunnerStalledError);
    expect(restartCalls).toBe(0);
    expect(commands.map((command) => command.type)).toEqual(["request_press_back"]);
  });

  test.each(["hierarchy", "screenshot"] as const)(
    "diagnostic %s on a resident client cannot restart the runner",
    async (read) => {
      const result =
        read === "hierarchy"
          ? client.requestHierarchySyncForObserver()
          : client.requestScreenshotForObserver();
      await expect(result).rejects.toBeInstanceOf(IosRunnerStalledError);
      expect(restartCalls).toBe(0);
      expect(sockets).toHaveLength(1);
    },
  );

  test("short busy responses leave lifecycle alone", async () => {
    blockingElapsedMs = 20_100;
    await expect(subject.getViewHierarchy()).rejects.toThrow("retry shortly");
    expect(restartCalls).toBe(0);
  });

  test("preserves stall evidence when there is no budget for recovery and a refetch", async () => {
    const result = await subject.getViewHierarchy(undefined, undefined, false, 0, undefined, 99);
    expect(result.hierarchy.unavailableReason).toBe("runner_stalled");
    expect(restartCalls).toBe(0);
    expect(commands).toHaveLength(1);
  });

  test("cancelled hierarchy requests cannot trigger recovery", async () => {
    const controller = new AbortController();
    onRequest = () => controller.abort(new Error("observation cancelled"));
    await expect(
      subject.getViewHierarchy(undefined, undefined, false, 0, controller.signal),
    ).rejects.toThrow("observation cancelled");
    expect(restartCalls).toBe(0);
  });

  test("failed restarts retain the existing backoff and exhaustion bound", async () => {
    restartFails = true;
    const first = await subject.getViewHierarchy();
    expect(first.hierarchy.unavailableReason).toBe("runner_stalled");
    expect(restartCalls).toBe(1);
    await subject.getViewHierarchy();
    expect(restartCalls).toBe(1);
    await timer.advanceTimeAsync(30_000);
    await subject.getViewHierarchy();
    expect(restartCalls).toBe(2);
    await timer.advanceTimeAsync(60_000);
    await expect(subject.getViewHierarchy()).rejects.toThrow("recovery exhausted");
    expect(restartCalls).toBe(3);
    await expect(subject.getViewHierarchy()).rejects.toThrow("recovery exhausted");
    expect(restartCalls).toBe(3);
  });
});
