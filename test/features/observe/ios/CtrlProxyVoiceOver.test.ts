import { beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import { CtrlProxyServicePortChangedError } from "../../../../src/features/observe/ios/IOSCtrlProxyClient";
import { ActionableError } from "../../../../src/models/ActionableError";
import type { CtrlProxyActionResult, IOSCtrlProxy } from "../../../../src/features/observe/ios";
import type { BootedDevice } from "../../../../src/models";
import {
  FakeWebSocket,
  createInstantFailureWebSocketFactory,
  WebSocketState,
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { runWithAbortSignal } from "../../../../src/utils/AbortContext";
import { CtrlProxyVoiceOver } from "../../../../src/features/observe/ios/CtrlProxyVoiceOver";
import { createIosDelegateHarness } from "../../../helpers/iosDelegateHarness";

describe("CtrlProxyVoiceOver", function () {
  let testDevice: BootedDevice;
  let fakeTimer: FakeTimer;
  const serverPort = 8765;

  beforeEach(function () {
    fakeTimer = new FakeTimer();
    fakeTimer.enableAutoAdvance();

    testDevice = {
      deviceId: "A1B2C3D4-E5F6-7890-ABCD-EF1234567890",
      platform: "ios",
      name: "iPhone 16 Simulator",
    };

    IOSCtrlProxyClient.resetInstances();
  });

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  class CapturingWebSocket extends FakeWebSocket {
    sentMessages: string[] = [];

    send(data: unknown): void {
      this.sentMessages.push(String(data));
      super.send(data);
    }
  }

  const createCapturingFactory = (
    timer?: FakeTimer,
  ): {
    factory: (url: string) => CapturingWebSocket;
    getSocket: () => CapturingWebSocket | null;
  } => {
    let socket: CapturingWebSocket | null = null;
    return {
      factory: (url: string) => {
        socket = new CapturingWebSocket(url, "none", 0, timer);
        return socket;
      },
      getSocket: () => socket,
    };
  };

  // The socket helpers wait on microtasks, not real turns: auto-advance fires a
  // pending request deadline whenever the test yields the event loop.
  const waitForSocket = async (
    getSocket: () => CapturingWebSocket | null,
  ): Promise<CapturingWebSocket | null> => {
    for (let i = 0; i < 100; i++) {
      const s = getSocket();
      if (s) {
        return s;
      }
      await Promise.resolve();
    }
    return getSocket();
  };

  const waitForSocketOpen = async (socket: FakeWebSocket | null): Promise<void> => {
    if (!socket || socket.readyState === WebSocketState.OPEN) {
      return;
    }
    await new Promise<void>((resolve) => socket.once("open", () => resolve()));
  };

  const waitForSentMessages = async (
    socket: CapturingWebSocket | null,
    minCount = 1,
  ): Promise<void> => {
    if (!socket) {
      return;
    }
    for (let i = 0; i < 100; i++) {
      if (commandPayloads(socket).length >= minCount) {
        return;
      }
      await Promise.resolve();
    }
  };

  const syncMessageTypes = new Set([
    "set_hierarchy_poll_interval",
    "set_network_mock_rules",
    "set_network_error_simulation",
  ]);

  const commandPayloads = (socket: CapturingWebSocket): any[] =>
    socket.sentMessages
      .map((message) => JSON.parse(message))
      .filter((payload) => !syncMessageTypes.has(payload.type));

  // ---------------------------------------------------------------------------
  // Tests
  // ---------------------------------------------------------------------------

  describe("requestVoiceOverState", function () {
    test("returns enabled=true when VoiceOver is running", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.requestVoiceOverState();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg.type).toBe("get_voiceover_state");
        expect(typeof sentMsg.requestId).toBe("string");

        socket!.simulateMessage(
          JSON.stringify({
            type: "voiceover_state_result",
            requestId: sentMsg.requestId,
            success: true,
            enabled: true,
            totalTimeMs: 2,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.enabled).toBe(true);
      } finally {
        await client.close();
      }
    });

    test("returns enabled=false when VoiceOver is not running", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.requestVoiceOverState();
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];

        socket!.simulateMessage(
          JSON.stringify({
            type: "voiceover_state_result",
            requestId: sentMsg.requestId,
            success: true,
            enabled: false,
            totalTimeMs: 1,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.enabled).toBe(false);
      } finally {
        await client.close();
      }
    });

    test("returns success=false and enabled=false when not connected", async function () {
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        createInstantFailureWebSocketFactory(fakeTimer),
        fakeTimer,
      );

      try {
        const result = await client.requestVoiceOverState();
        expect(result.success).toBe(false);
        expect(result.enabled).toBe(false);
        expect(result.error).toBeDefined();
      } finally {
        await client.close();
      }
    });

    // NB: a former "sends correct message type get_voiceover_state" test was
    // deleted here (issue #4174, item 14) — it asserted only `sentMsg.type`, a
    // strict subset of "returns enabled=true when VoiceOver is running", which
    // already asserts the type AND the requestId AND the decoded result.

    // The VoiceOver-detection probe runs before EVERY tapAny/tapOn iOS tap
    // (VoiceOver on or off). A caller's outer deadline can expire while the
    // connection is still opening (a reconnect/auto-setup is not itself
    // cancellable) -- `sendCommand` checks the signal right after
    // `ensureConnected()` resolves and before dispatch, so an already-expired
    // probe is never sent to the device (issue #6306 review, P1).
    test("never dispatches when the caller's signal is already aborted", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const controller = new AbortController();
      controller.abort(new Error("outer deadline exceeded"));

      try {
        const result = await client.requestVoiceOverState(5000, undefined, controller.signal);
        // `sendCommand` checks the signal right after `ensureConnected()`
        // resolves and before dispatch (issue #6306 review, P1): the probe
        // must never reach the device once the caller's deadline is spent,
        // even though the connection itself opened successfully (the
        // connection handshake itself may still send its own unrelated
        // setup messages, e.g. `set_network_error_simulation`).
        const socket = getSocket();
        const sentTypes = (socket?.sentMessages ?? []).map(
          (raw) => (JSON.parse(raw) as { type?: string }).type,
        );
        expect(sentTypes).not.toContain("get_voiceover_state");
        expect(result.success).toBe(false);
      } finally {
        await client.close();
      }
    });
  });

  describe("requestVoiceOverActivate", function () {
    for (const action of ["activate", "long_press"] as const) {
      test.each(["timeout", "connection drop", "abort"] as const)(
        `${action}: dispatched %s is unconfirmed and sends exactly one request`,
        async (failure) => {
          const timer = new FakeTimer();
          const { factory, getSocket } = createCapturingFactory(timer);
          const client = IOSCtrlProxyClient.createForTesting(
            testDevice,
            serverPort,
            factory,
            timer,
          );
          const controller = new AbortController();
          try {
            const pending = runWithAbortSignal(controller.signal, () =>
              client.requestVoiceOverActivate("Submit", action, 5000),
            );
            const socket = await waitForSocket(getSocket);
            await waitForSocketOpen(socket);
            await waitForSentMessages(socket);
            expect(commandPayloads(socket!)).toHaveLength(1);
            expect(commandPayloads(socket!)[0].action).toBe(action);
            if (failure === "timeout") {
              timer.advanceTime(5000);
            } else if (failure === "abort") {
              controller.abort(new Error("activation cancelled"));
              // Settle the old implementation too, which ignored cancellation.
              await Promise.resolve();
              timer.advanceTime(5000);
            } else {
              socket!.close();
            }
            const result = await pending;
            expect(result).toMatchObject({
              success: false,
              dispatched: true,
              acknowledged: false,
              retryable: false,
            });
            expect(result.error).toContain(
              failure === "timeout"
                ? "Timeout waiting for action_result"
                : failure === "abort"
                  ? "activation cancelled"
                  : "WebSocket connection closed",
            );
            expect(commandPayloads(socket!)).toHaveLength(1);
          } finally {
            await client.close();
          }
        },
      );

      test.each(["Element not found", "Not activatable", "Timeout waiting for action_result"])(
        `${action}: a runner refusal is acknowledged even when its text says %s`,
        async (error) => {
          const h = createIosDelegateHarness();
          const pending = new CtrlProxyVoiceOver(h.context).requestVoiceOverActivate(
            "Submit",
            action,
          );
          await Promise.resolve();
          h.resolveLast({ success: false, error });
          expect(await pending).toMatchObject({
            success: false,
            error,
            dispatched: true,
            acknowledged: true,
          });
          expect(h.sentMessages).toHaveLength(1);
        },
      );
    }

    test("not connected is not dispatched", async () => {
      const h = createIosDelegateHarness({ connected: false });
      const result = await new CtrlProxyVoiceOver(h.context).requestVoiceOverActivate(
        "Submit",
        "activate",
      );
      expect(result).toMatchObject({ success: false, dispatched: false, acknowledged: false });
      expect(result.retryable).toBeUndefined();
      expect(h.sentMessages).toHaveLength(0);
    });

    test("failed send is not dispatched and remains eligible for fallback", async () => {
      const h = createIosDelegateHarness();
      h.context.getWebSocket()!.send = () => {
        throw new Error("send failed");
      };
      const result = await new CtrlProxyVoiceOver(h.context).requestVoiceOverActivate(
        "Submit",
        "activate",
      );
      expect(result).toMatchObject({
        success: false,
        error: "send failed",
        dispatched: false,
        acknowledged: false,
      });
      expect(result.retryable).toBeUndefined();
      expect(h.requestManager.getPendingCount()).toBe(0);
    });

    test.each(["action_result", "error"])("%s runner refusal is acknowledged", async (type) => {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      try {
        const pending = client.requestVoiceOverActivate("Submit", "activate");
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket);
        const error =
          type === "error" ? "Unknown command type: request_action" : "Element not found";
        socket!.simulateMessage(
          JSON.stringify({
            type,
            requestId: commandPayloads(socket!)[0].requestId,
            success: false,
            error,
          }),
        );
        const result = await pending;
        expect(result).toMatchObject({ success: false, dispatched: true, acknowledged: true });
        expect(result.error).toContain(
          type === "error" ? "rejected request_action as unknown" : error,
        );
        expect(result.retryable).toBeUndefined();
        expect(commandPayloads(socket!)).toHaveLength(1);
      } finally {
        await client.close();
      }
    });

    test("a dispatched runner_busy rejection is rethrown unchanged", async () => {
      const h = createIosDelegateHarness();
      const error = new ActionableError(
        "iOS runner is busy executing request_tap for 1.0s; retry shortly",
      );
      const pending = new CtrlProxyVoiceOver(h.context).requestVoiceOverActivate(
        "Submit",
        "activate",
      );
      await Promise.resolve();
      expect(h.sentMessages).toHaveLength(1);
      h.requestManager.reject(h.lastRequestId()!, error);
      await expect(pending).rejects.toBe(error);
      expect(h.sentMessages).toHaveLength(1);
    });

    test("a service port change after dispatch remains unconfirmed", async () => {
      const h = createIosDelegateHarness();
      const pending = new CtrlProxyVoiceOver(h.context).requestVoiceOverActivate(
        "Submit",
        "activate",
      );
      await Promise.resolve();
      h.requestManager.cancelAll(new CtrlProxyServicePortChangedError());
      expect(await pending).toMatchObject({
        success: false,
        error: "CtrlProxy service port changed",
        dispatched: true,
        acknowledged: false,
        retryable: false,
      });
      expect(h.sentMessages).toHaveLength(1);
    });

    test("an ActionableError send failure is not a runner reply", async () => {
      const h = createIosDelegateHarness();
      h.context.getWebSocket()!.send = () => {
        throw new ActionableError("send failed");
      };
      expect(
        await new CtrlProxyVoiceOver(h.context).requestVoiceOverActivate("Submit", "activate"),
      ).toMatchObject({
        success: false,
        error: "send failed",
        dispatched: false,
        acknowledged: false,
      });
    });

    test.each(["result", "catch"] as const)(
      "an already aborted caller rethrows its reason on the %s path without dispatch",
      async (path) => {
        const h = createIosDelegateHarness();
        const controller = new AbortController();
        const error = new ActionableError("activation cancelled before dispatch");
        controller.abort(error);
        if (path === "catch") {
          h.context.ensureConnected = async () => {
            throw error;
          };
        }
        const pending = runWithAbortSignal(controller.signal, () =>
          new CtrlProxyVoiceOver(h.context).requestVoiceOverActivate("Submit", "activate"),
        );
        await expect(pending).rejects.toBe(error);
        expect(h.sentMessages).toHaveLength(0);
        expect(h.requestManager.getPendingCount()).toBe(0);
      },
    );

    test("an ActionableError abort after dispatch remains unconfirmed", async () => {
      const h = createIosDelegateHarness();
      const controller = new AbortController();
      const error = new ActionableError("activation cancelled after dispatch");
      const pending = runWithAbortSignal(controller.signal, () =>
        new CtrlProxyVoiceOver(h.context).requestVoiceOverActivate("Submit", "activate"),
      );
      await Promise.resolve();
      expect(h.sentMessages).toHaveLength(1);
      controller.abort(error);
      expect(await pending).toMatchObject({
        success: false,
        error: error.message,
        dispatched: true,
        acknowledged: false,
        retryable: false,
      });
      expect(h.sentMessages).toHaveLength(1);
    });

    // Regression guard for #2857: VoiceOver activation must ride the existing
    // `request_action` command (a real `RequestType`), not the phantom
    // `request_voiceover_action` the runner rejected as "Unknown command type".
    test("sends request_action (not request_voiceover_action) and passes label + action", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.requestVoiceOverActivate("Submit", "activate");
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg.type).toBe("request_action");
        expect(sentMsg.type).not.toBe("request_voiceover_action");
        expect(sentMsg.label).toBe("Submit");
        expect(sentMsg.action).toBe("activate");
        expect(typeof sentMsg.requestId).toBe("string");

        // The runner replies with action_result, which resolves the request.
        socket!.simulateMessage(
          JSON.stringify({
            type: "action_result",
            requestId: sentMsg.requestId,
            success: true,
            action: "activate",
            totalTimeMs: 3,
          }),
        );

        const result = await resultPromise;
        expect(result).toMatchObject({ success: true, dispatched: true, acknowledged: true });
      } finally {
        await client.close();
      }
    });

    test("maps long_press through the same request_action command", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const bounds = { left: 0, top: 50, right: 50, bottom: 90 };
        const resultPromise = client.requestVoiceOverActivate(
          "Row",
          "long_press",
          5000,
          undefined,
          {
            bounds,
            duration: 1750,
          },
        );
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg.type).toBe("request_action");
        expect(sentMsg.action).toBe("long_press");
        expect(sentMsg.bounds).toEqual(bounds);
        expect(sentMsg.duration).toBe(1750);

        socket!.simulateMessage(
          JSON.stringify({
            type: "action_result",
            requestId: sentMsg.requestId,
            success: true,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
      } finally {
        await client.close();
      }
    });

    // Regression guard for #2956: `requestVoiceOverActivate` and `requestAction`
    // are filled from the same `action_result` decode path, so they must share a
    // single return type. If someone re-introduces a divergent
    // `CtrlProxyVoiceOverActionResult`, these mutual assignments stop compiling
    // and the typecheck gate fails.
    test("returns the same CtrlProxyActionResult type as requestAction (compile-time guard)", function () {
      type ActivateResult = Awaited<ReturnType<IOSCtrlProxy["requestVoiceOverActivate"]>>;
      type ActionResult = Awaited<ReturnType<IOSCtrlProxy["requestAction"]>>;

      // Both directions must hold → the two shapes are identical.
      const fromAction: ActivateResult = {} as ActionResult;
      const fromActivate: ActionResult = {} as ActivateResult;
      // And both are exactly CtrlProxyActionResult.
      const canonical: CtrlProxyActionResult = fromActivate;
      const _roundTrip: ActivateResult = canonical;

      expect(fromAction).toBeDefined();
      expect(_roundTrip).toBeDefined();
    });

    // Regression guard for #2956: when the connected device does not advertise
    // `request_action`, `requestVoiceOverActivate` must resolve to a graceful
    // failure (never send on the wire, never hang) rather than time out. Note
    // this contract is satisfied by `sendCommand`'s default unsupported-command
    // fallback too — the wrapper's own `unsupportedCommandError` handler (added
    // here for parity with `requestVoiceOverState`) produces the byte-identical
    // shape, so this test pins the observable behavior, not the handler's
    // presence specifically.
    test("resolves gracefully when the device does not support request_action", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);

        // Device advertises a command set that excludes request_action.
        socket!.simulateMessage(
          JSON.stringify({
            type: "connected",
            id: 1,
            supportedCommands: ["request_recent_apps"],
          }),
        );

        const result = await client.requestVoiceOverActivate("Submit", "activate");

        expect(result.success).toBe(false);
        expect(result.totalTimeMs).toBe(0);
        expect(result.error).toContain("request_action");
        expect(result).toMatchObject({ dispatched: false, acknowledged: false });
        // Unsupported commands short-circuit before hitting the wire.
        expect(commandPayloads(socket!)).toHaveLength(0);
      } finally {
        await client.close();
      }
    });
  });

  describe("requestAction", function () {
    test("sends long-press duration with the resource-id action", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.requestAction(
          "long_press",
          "com.test.app:id/submit_button",
          undefined,
          5000,
          undefined,
          { duration: 1750 },
        );
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg).toMatchObject({
          type: "request_action",
          action: "long_press",
          resourceId: "com.test.app:id/submit_button",
          label: null,
          duration: 1750,
        });

        socket!.simulateMessage(
          JSON.stringify({ type: "action_result", requestId: sentMsg.requestId, success: true }),
        );
        expect((await resultPromise).success).toBe(true);
      } finally {
        await client.close();
      }
    });

    test("does not dispatch a cancelled system-alert action", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const controller = new AbortController();
      controller.abort(new Error("openLink deadline exceeded"));

      try {
        const result = await client.requestAction(
          "system_alert_accept",
          undefined,
          undefined,
          5000,
          undefined,
          { abortSignal: controller.signal },
        );
        const sentTypes = (getSocket()?.sentMessages ?? []).map(
          (raw) => (JSON.parse(raw) as { type?: string }).type,
        );

        expect(sentTypes).not.toContain("request_action");
        expect(result.success).toBe(false);
      } finally {
        await client.close();
      }
    });

    test("rejects a cancelled system-alert action before a late response can succeed", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );
      const controller = new AbortController();
      const cancellation = new Error("openLink deadline exceeded");

      try {
        const result = client.requestAction(
          "system_alert_accept",
          undefined,
          undefined,
          5000,
          undefined,
          { abortSignal: controller.signal },
        );
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);
        const sentMsg = commandPayloads(socket!)[0];

        controller.abort(cancellation);
        socket!.simulateMessage(
          JSON.stringify({
            type: "action_result",
            requestId: sentMsg.requestId,
            success: true,
            action: "system_alert_accept",
          }),
        );

        await expect(result).rejects.toBe(cancellation);
      } finally {
        await client.close();
      }
    });
  });

  describe("requestActivateAccessibilityLink", function () {
    test.each(["timeout", "transport", "refusal", "abort after dispatch"])(
      "%s tracks dispatch, sends once, and cleans correlation",
      async (mode) => {
        const timer = new FakeTimer();
        const { factory, getSocket } = createCapturingFactory(timer);
        const client = IOSCtrlProxyClient.createForTesting(testDevice, serverPort, factory, timer);
        const controller = new AbortController();
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
          const socket = await waitForSocket(getSocket);
          await waitForSocketOpen(socket);
          await waitForSentMessages(socket);
          const requestId = commandPayloads(socket!)[0].requestId;
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
            socket!.simulateMessage(
              JSON.stringify({
                type: "action_result",
                requestId,
                success: false,
                error: "link refused",
                totalTimeMs: 1,
              }),
            );
          }
          const result = await pending;
          expect(result).toMatchObject({
            success: false,
            dispatched: true,
            acknowledged: mode === "refusal",
          });
          expect(result.retryable).toBe(mode === "refusal" ? undefined : false);
          expect(commandPayloads(socket!)).toHaveLength(1);
          expect(dispatchCount).toBe(1);
          expect(client["requestManager"].getPendingCount()).toBe(0);
          if (mode === "refusal") {
            expect(result.error).toBe("link refused");
          }
        } finally {
          await client.close();
        }
      },
    );

    test("abort while connecting rethrows the reason without dispatch or registration", async () => {
      const h = createIosDelegateHarness();
      let finish!: (connected: boolean) => void;
      h.context.ensureConnected = () =>
        new Promise<boolean>((resolve) => {
          finish = resolve;
        });
      const controller = new AbortController();
      const reason = new Error("cancelled before connection");
      const pending = new CtrlProxyVoiceOver(h.context).requestActivateAccessibilityLink(
        "Terms",
        0,
        undefined,
        5000,
        undefined,
        controller.signal,
      );
      controller.abort(reason);
      finish(true);
      // An unfixed delegate sends despite cancellation; settle it so the regression fails promptly.
      await Promise.resolve();
      h.resolveLast({ success: true });
      await expect(pending).rejects.toBe(reason);
      expect(h.sentMessages).toHaveLength(0);
      expect(h.requestManager.getPendingCount()).toBe(0);
    });

    // GesturePerformer.swift:119-122 renders the reasons at 2147/2166 with
    // these prefixes; CommandHandler.swift:308 sends localizedDescription on the wire.
    test.each([
      "Gesture failed: Semantic link owner 'x' is missing, not actionable, or ambiguous",
      "Element not found: semantic link 'T' occurrence 0",
    ])("preserves the runner error reply verbatim: %s", async function (error) {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.requestActivateAccessibilityLink("T", 0, "x");
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg.type).toBe("request_activate_accessibility_link");
        socket!.simulateMessage(
          JSON.stringify({ type: "error", requestId: sentMsg.requestId, error }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(false);
        expect(result.error).toBe(error);
        expect(result.error).not.toContain("does not support");
        expect(result).toMatchObject({ dispatched: true, acknowledged: true });
      } finally {
        await client.close();
      }
    });

    test("reports an old runner's unknown semantic-link command as unsupported", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.requestActivateAccessibilityLink("T", 0, "x");
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        // ios/control-proxy/Sources/CtrlProxyRewrite/CommandError.swift:28.
        socket!.simulateMessage(
          JSON.stringify({
            type: "error",
            requestId: sentMsg.requestId,
            error: "Unknown command type: request_activate_accessibility_link",
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(false);
        expect(result.error).toContain(
          "runner rejected request_activate_accessibility_link as unknown",
        );
        expect(result.error).toContain("The runner is likely older than this daemon");
        expect(result.error).toContain("rebuild and redeploy");
      } finally {
        await client.close();
      }
    });

    test("preserves a successful action_result and semantic-link parameters", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.requestActivateAccessibilityLink("T", 0, "x");
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg).toMatchObject({
          type: "request_activate_accessibility_link",
          text: "T",
          occurrence: 0,
          ownerResourceId: "x",
        });
        socket!.simulateMessage(
          JSON.stringify({
            type: "action_result",
            requestId: sentMsg.requestId,
            success: true,
            totalTimeMs: 3,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
        expect(result.totalTimeMs).toBe(3);
        expect(result).toMatchObject({ dispatched: true, acknowledged: true });
        expect(result.error).toBeUndefined();
      } finally {
        await client.close();
      }
    });

    test("reports a capability miss before dispatch as unsupported", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        await client.ensureConnected();
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        socket!.simulateMessage(
          JSON.stringify({
            type: "connected",
            id: 1,
            supportedCommands: ["request_action"],
          }),
        );

        const result = await client.requestActivateAccessibilityLink("T", 0, "x");
        expect(result.success).toBe(false);
        expect(result.error).toContain(
          "runner does not support request_activate_accessibility_link",
        );
        expect(commandPayloads(socket!)).toHaveLength(0);
      } finally {
        await client.close();
      }
    });
  });

  describe("requestSetVoiceOverEnabled", function () {
    test("emits set_voiceover_state with the enabled param and resolves on success", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.requestSetVoiceOverEnabled(true);
        const socket = await waitForSocket(getSocket);
        expect(socket).not.toBeNull();
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg.type).toBe("set_voiceover_state");
        expect((sentMsg as { enabled?: boolean }).enabled).toBe(true);
        expect(typeof sentMsg.requestId).toBe("string");

        socket!.simulateMessage(
          JSON.stringify({
            type: "voiceover_set_result",
            requestId: sentMsg.requestId,
            success: true,
            totalTimeMs: 3,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(true);
      } finally {
        await client.close();
      }
    });

    test("resolves a runner failure as a typed result (never a silent success)", async function () {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(
        testDevice,
        serverPort,
        factory,
        fakeTimer,
      );

      try {
        const resultPromise = client.requestSetVoiceOverEnabled(false);
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect((sentMsg as { enabled?: boolean }).enabled).toBe(false);

        socket!.simulateMessage(
          JSON.stringify({
            type: "voiceover_set_result",
            requestId: sentMsg.requestId,
            success: false,
            error: "VoiceOver toggle row not found",
            totalTimeMs: 4,
          }),
        );

        const result = await resultPromise;
        expect(result.success).toBe(false);
        expect(result.error).toContain("VoiceOver toggle row not found");
      } finally {
        await client.close();
      }
    });
  });
});
