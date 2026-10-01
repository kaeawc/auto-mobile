import { FakeSocket } from "../fakes/FakeNetServer";
import * as net from "node:net";
import { describe, expect, mock, spyOn, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import { logger } from "../../src/utils/logger";

let createdSocket: FakeSocket | undefined;
mock.module("node:net", () => ({
  ...net,
  createConnection: (_socketPath: string, onConnect: () => void) => {
    createdSocket = new FakeSocket();
    queueMicrotask(onConnect);
    return createdSocket;
  },
}));

const { DaemonClient, DaemonUnavailableError } = await import("../../src/daemon/client");
const { DaemonDisconnectError } = await import("../../src/daemon/DaemonDisconnectError");

describe("DaemonClient socket error disconnect cause", () => {
  test("surfaces a disconnect cause on each pending request on transport error", async () => {
    const client = new DaemonClient(
      "/fake/socket",
      1_000,
      new FakeTimer(),
      {},
      null,
      undefined,
      "win32",
    );
    await client.connect();

    const request = client.callDaemonMethod("tools/list", {}, { timeoutMs: 250 });
    const transportError = new Error("read ECONNRESET");
    (transportError as NodeJS.ErrnoException).code = "ECONNRESET";
    createdSocket!.emit("error", transportError);

    try {
      await request;
      expect.unreachable("the pending request should reject");
    } catch (error) {
      expect(error).toBeInstanceOf(DaemonUnavailableError);
      expect((error as DaemonUnavailableError).cause).toBeInstanceOf(DaemonDisconnectError);
      const disconnectCause = (error as DaemonUnavailableError).cause as DaemonDisconnectError;
      expect(disconnectCause.toolName).toBe("tools/list");
    }
  });

  test("decodes a response split inside a multibyte character", async () => {
    const client = new DaemonClient(
      "/fake/socket",
      1_000,
      new FakeTimer(),
      {},
      null,
      undefined,
      "win32",
    );
    await client.connect();
    const response = client.callDaemonMethod("tools/list", {}, { timeoutMs: 250 });
    await Promise.resolve();
    const request = JSON.parse(createdSocket!.writes[0]);
    const frame = Buffer.from(
      JSON.stringify({ id: request.id, type: "mcp_response", success: true, result: "日" }) + "\n",
    );
    const split = frame.indexOf(Buffer.from("日")) + 1;
    createdSocket!.emit("data", frame.subarray(0, split));
    createdSocket!.emit("data", frame.subarray(split));
    expect(await response).toBe("日");
    await client.close();
  });

  test("rejects the sole pending request promptly on a null-id parse error", async () => {
    const client = new DaemonClient(
      "/fake/socket",
      1_000,
      new FakeTimer(),
      {},
      null,
      undefined,
      "win32",
    );
    await client.connect();
    const response = client.callDaemonMethod("tools/list", {}, { timeoutMs: 250 });
    await Promise.resolve();
    createdSocket!.emit(
      "data",
      Buffer.from(
        JSON.stringify({
          id: null,
          type: "mcp_response",
          success: false,
          error: "Parse error in daemon socket request",
          code: -32700,
        }) + "\n",
      ),
    );
    await expect(response).rejects.toThrow("Parse error in daemon socket request");
    await client.close();
  });

  test("drops a null-id response when two requests are pending and warns", async () => {
    const client = new DaemonClient(
      "/fake/socket",
      1_000,
      new FakeTimer(),
      {},
      null,
      undefined,
      "win32",
    );
    const warning = spyOn(logger, "warn").mockImplementation(() => {});
    try {
      await client.connect();
      const first = client.callDaemonMethod("tools/list", {}, { timeoutMs: 250 });
      const second = client.callDaemonMethod("resources/list", {}, { timeoutMs: 250 });
      await Promise.resolve();
      const [firstRequest, secondRequest] = createdSocket!.writes.map((write) => JSON.parse(write));
      createdSocket!.emit(
        "data",
        Buffer.from(
          JSON.stringify({
            id: null,
            type: "mcp_response",
            success: false,
            error: "Parse error in daemon socket request",
            code: -32700,
          }) + "\n",
        ),
      );
      expect(warning).toHaveBeenCalledWith(expect.stringContaining("2 pending requests"));
      createdSocket!.emit(
        "data",
        Buffer.from(
          JSON.stringify({ id: firstRequest.id, type: "mcp_response", success: true, result: 1 }) +
            "\n" +
            JSON.stringify({
              id: secondRequest.id,
              type: "mcp_response",
              success: true,
              result: 2,
            }) +
            "\n",
        ),
      );
      expect(await first).toBe(1);
      expect(await second).toBe(2);
    } finally {
      warning.mockRestore();
      await client.close();
    }
  });

  test("drops an incomplete frame when a new socket connects", async () => {
    const client = new DaemonClient(
      "/fake/socket",
      1_000,
      new FakeTimer(),
      {},
      null,
      undefined,
      "win32",
    );
    await client.connect();
    createdSocket!.emit("data", Buffer.from('{"id":"stale"'));
    createdSocket!.emit("close");
    await client.connect();
    const response = client.callDaemonMethod("tools/list", {}, { timeoutMs: 250 });
    await Promise.resolve();
    const request = JSON.parse(createdSocket!.writes[0]);
    createdSocket!.emit(
      "data",
      Buffer.from(
        JSON.stringify({ id: request.id, type: "mcp_response", success: true, result: "fresh" }) +
          "\n",
      ),
    );
    expect(await response).toBe("fresh");
    await client.close();
  });
});
