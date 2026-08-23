import { beforeEach, describe, expect, test } from "bun:test";
import { IOSCtrlProxyClient } from "../../../../src/features/observe/ios";
import type { CtrlProxyActionResult, IOSCtrlProxy } from "../../../../src/features/observe/ios";
import type { BootedDevice } from "../../../../src/models";
import {
  FakeWebSocket,
  createInstantFailureWebSocketFactory,
  WebSocketState,
} from "../../../fakes/FakeWebSocket";
import { FakeTimer } from "../../../fakes/FakeTimer";

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

  const waitForSocket = async (
    getSocket: () => CapturingWebSocket | null,
  ): Promise<CapturingWebSocket | null> => {
    for (let i = 0; i < 5; i++) {
      const s = getSocket();
      if (s) {
        return s;
      }
      await new Promise((r) => setImmediate(r));
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
    for (let i = 0; i < 10; i++) {
      if (commandPayloads(socket).length >= minCount) {
        return;
      }
      await new Promise((r) => setImmediate(r));
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
  });

  describe("requestVoiceOverActivate", function () {
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
        expect(result.success).toBe(true);
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
        const resultPromise = client.requestVoiceOverActivate("Row", "long_press");
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect(sentMsg.type).toBe("request_action");
        expect(sentMsg.action).toBe("long_press");

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
        // Unsupported commands short-circuit before hitting the wire.
        expect(commandPayloads(socket!)).toHaveLength(0);
      } finally {
        await client.close();
      }
    });
  });

  describe("requestSetVoiceOverEnabled", function() {
    test("emits set_voiceover_state with the enabled param and resolves on success", async function() {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(testDevice, serverPort, factory, fakeTimer);

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

        socket!.simulateMessage(JSON.stringify({
          type: "voiceover_set_result",
          requestId: sentMsg.requestId,
          success: true,
          totalTimeMs: 3,
        }));

        const result = await resultPromise;
        expect(result.success).toBe(true);
      } finally {
        await client.close();
      }
    });

    test("resolves a runner failure as a typed result (never a silent success)", async function() {
      const { factory, getSocket } = createCapturingFactory(fakeTimer);
      const client = IOSCtrlProxyClient.createForTesting(testDevice, serverPort, factory, fakeTimer);

      try {
        const resultPromise = client.requestSetVoiceOverEnabled(false);
        const socket = await waitForSocket(getSocket);
        await waitForSocketOpen(socket);
        await waitForSentMessages(socket, 1);

        const sentMsg = commandPayloads(socket!)[0];
        expect((sentMsg as { enabled?: boolean }).enabled).toBe(false);

        socket!.simulateMessage(JSON.stringify({
          type: "voiceover_set_result",
          requestId: sentMsg.requestId,
          success: false,
          error: "VoiceOver toggle row not found",
          totalTimeMs: 4,
        }));

        const result = await resultPromise;
        expect(result.success).toBe(false);
        expect(result.error).toContain("VoiceOver toggle row not found");
      } finally {
        await client.close();
      }
    });
  });
});
