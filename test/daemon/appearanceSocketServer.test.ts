import { describe, it, expect, beforeEach } from "bun:test";
import { Socket } from "node:net";
import { AppearanceSocketServer } from "../../src/daemon/appearanceSocketServer";
import { AppearanceSocketResponse } from "../../src/daemon/appearanceSocketTypes";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeSocket } from "../fakes/FakeNetServer";

/**
 * Drives requests through the real inherited processLine dispatch (queue +
 * handleLine + handleRequest) so validation and command resolution actually run.
 * The success path is deliberately NOT exercised: getAppearanceConfig /
 * updateAppearanceConfig resolve the real file-backed DB (which trips the #3067
 * guard under `bun test`) and applyToTargets reaches DaemonState /
 * DeviceSessionManager singletons — none of which the class exposes an injection
 * seam for. Every row below rejects at the validation/dispatch layer, before any
 * of those side effects.
 */
class TestableAppearanceSocketServer extends AppearanceSocketServer {
  constructor(timer: FakeTimer) {
    super("/fake/path/appearance.sock", timer);
  }

  async startFake(): Promise<void> {
    (this as any).server = { listening: true };
  }

  async simulateLine(socket: FakeSocket, line: string): Promise<void> {
    await (this as any).processLine(socket as unknown as Socket, line);
    const pending = (this as any).pendingBySocket.get(socket);
    if (pending) {
      await pending;
    }
  }
}

describe("AppearanceSocketServer", () => {
  let server: TestableAppearanceSocketServer;
  let timer: FakeTimer;
  let socket: FakeSocket;

  beforeEach(async () => {
    timer = new FakeTimer();
    server = new TestableAppearanceSocketServer(timer);
    await server.startFake();
    socket = new FakeSocket();
  });

  describe("validation and command resolution (rejects before side effects)", () => {
    interface Row {
      name: string;
      request: Record<string, unknown>;
      expectedError: string;
    }

    // Byte-for-byte against src: default case throws
    // `Unsupported appearance command: ${command}` (~:91); set_appearance throws
    // "set_appearance requires mode: light | dark | auto" (~:71); set_appearance_sync
    // throws "set_appearance_sync requires enabled boolean" (~:53). createErrorResponse
    // (~:95-99) wraps each as { id, type:"appearance_response", success:false, error }.
    const rows: Row[] = [
      {
        name: "neither command nor method → unsupported (missing fields)",
        request: { id: "r1", mode: "light" },
        expectedError: "Unsupported appearance command: undefined",
      },
      {
        name: "unknown command → unsupported",
        request: { id: "r2", command: "bogus" },
        expectedError: "Unsupported appearance command: bogus",
      },
      {
        name: "set_appearance empty-string mode (top-level shape) → requires mode",
        request: { id: "r3", command: "set_appearance", mode: "" },
        expectedError: "set_appearance requires mode: light | dark | auto",
      },
      {
        name: "set_appearance unknown mode (params shape) → requires mode",
        request: { id: "r4", command: "set_appearance", params: { mode: "purple" } },
        expectedError: "set_appearance requires mode: light | dark | auto",
      },
      {
        name: "set_appearance via method shape resolves the command (method fallback)",
        request: { id: "r5", method: "set_appearance", mode: "nope" },
        expectedError: "set_appearance requires mode: light | dark | auto",
      },
      {
        name: "set_appearance_sync non-boolean enabled (top-level shape) → requires boolean",
        request: { id: "r6", command: "set_appearance_sync", enabled: "yes" },
        expectedError: "set_appearance_sync requires enabled boolean",
      },
      {
        name: "set_appearance_sync non-boolean enabled (params shape) → requires boolean",
        request: { id: "r7", command: "set_appearance_sync", params: { enabled: 5 } },
        expectedError: "set_appearance_sync requires enabled boolean",
      },
      {
        name: "set_appearance_sync via method shape resolves the command (method fallback)",
        request: { id: "r8", method: "set_appearance_sync", enabled: null },
        expectedError: "set_appearance_sync requires enabled boolean",
      },
    ];

    for (const row of rows) {
      it(row.name, async () => {
        await server.simulateLine(socket, JSON.stringify(row.request));

        const messages = socket.getWrittenMessages<AppearanceSocketResponse>();
        expect(messages).toHaveLength(1);
        expect(messages[0]).toEqual({
          id: row.request.id as string,
          type: "appearance_response",
          success: false,
          error: row.expectedError,
        });
      });
    }

    it("resolves the mode param equivalently from params and top-level shapes", async () => {
      // Both dual-shape carriers for an INVALID mode reject with the SAME error,
      // proving `request.params?.mode ?? request.mode` reads both shapes.
      const topLevel = new FakeSocket();
      const params = new FakeSocket();

      await server.simulateLine(
        topLevel,
        JSON.stringify({ id: "eq-top", command: "set_appearance", mode: "zzz" }),
      );
      await server.simulateLine(
        params,
        JSON.stringify({ id: "eq-params", command: "set_appearance", params: { mode: "zzz" } }),
      );

      const topMsg = topLevel.getWrittenMessages<AppearanceSocketResponse>()[0];
      const paramsMsg = params.getWrittenMessages<AppearanceSocketResponse>()[0];
      expect(topMsg.error).toBe("set_appearance requires mode: light | dark | auto");
      expect(paramsMsg.error).toBe(topMsg.error);
    });
  });
});
