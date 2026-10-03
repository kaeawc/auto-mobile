import { describe, expect, test, beforeEach } from "bun:test";
import { Duplex } from "node:stream";
import { DaemonClient, DaemonShuttingDownError } from "../../src/daemon/client";
import { DAEMON_SHUTTING_DOWN_ERROR_CODE } from "../../src/daemon/constants";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../src/daemon/types";
import { McpOverloadError } from "../../src/daemon/McpTimeoutError";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

interface DaemonClientFrameInternals {
  handleData(data: Buffer): void;
}

/**
 * Capture every frame written to the socket so the test can inspect the request
 * `id` the client stamped. The client writes newline-delimited JSON.
 */
function createCapturingSocket(writes: string[]): Duplex {
  return new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
  });
}

function createConnectedClient(
  fakeTimer: FakeTimer,
  idGenerator: CountingIdGenerator,
  writes: string[],
): DaemonClient {
  const client = new DaemonClient("/fake/socket", 1000, fakeTimer, {}, null, idGenerator);
  (client as any).connected = true;
  (client as any).socket = createCapturingSocket(writes);
  return client;
}

function parseRequestIds(writes: string[]): string[] {
  return writes
    .join("")
    .split("\n")
    .filter((line) => line.trim().length > 0)
    .map((line) => JSON.parse(line).id as string);
}

describe("DaemonClient request id comes from the injected IdGenerator", () => {
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
  });

  test("sendRequest (callTool) stamps ids from the injected generator", async () => {
    const idGenerator = new CountingIdGenerator("req");
    const writes: string[] = [];
    const client = createConnectedClient(fakeTimer, idGenerator, writes);

    // Never resolves (black-hole read), but the frame is written synchronously.
    // close() below rejects these pending requests, so swallow to avoid unhandled rejections.
    const pending = [
      client.callTool("tapOn", {}).catch(() => {}),
      client.callTool("tapOn", {}).catch(() => {}),
    ];

    expect(parseRequestIds(writes)).toEqual(["req-1", "req-2"]);

    await client.close();
    await Promise.all(pending);
  });

  test("callDaemonMethod stamps ids from the injected generator", async () => {
    const idGenerator = new CountingIdGenerator("req");
    const writes: string[] = [];
    const client = createConnectedClient(fakeTimer, idGenerator, writes);

    const pending = client.callDaemonMethod("daemon/status").catch(() => {});

    expect(parseRequestIds(writes)).toEqual(["req-1"]);

    await client.close();
    await pending;
  });

  test.each([undefined, true] as const)(
    "preserves shutdown dispatch marker %s in the client error",
    async (requestMayHaveDispatched) => {
      const idGenerator = new CountingIdGenerator("req");
      const writes: string[] = [];
      const client = createConnectedClient(fakeTimer, idGenerator, writes);

      const pending = client.callTool("tapOn", {});
      (client as unknown as DaemonClientFrameInternals).handleData(
        Buffer.from(
          JSON.stringify({
            id: "req-1",
            type: "mcp_response",
            success: false,
            error: "A malformed error message must not affect shutdown classification",
            daemonShuttingDown: {
              code: DAEMON_SHUTTING_DOWN_ERROR_CODE,
              retryable: true,
              ...(requestMayHaveDispatched ? { requestMayHaveDispatched } : {}),
            },
          }) + "\n",
        ),
      );

      const error: unknown = await pending.catch((cause: unknown) => cause);
      expect(error).toBeInstanceOf(DaemonShuttingDownError);
      expect(error).toMatchObject({ requestMayHaveDispatched: requestMayHaveDispatched === true });
      await client.close();
    },
  );

  test("does not classify an unmarked error message as daemon shutdown", async () => {
    const idGenerator = new CountingIdGenerator("req");
    const writes: string[] = [];
    const client = createConnectedClient(fakeTimer, idGenerator, writes);

    const pending = client.callTool("tapOn", {});
    (client as any).handleData(
      Buffer.from(
        JSON.stringify({
          id: "req-1",
          type: "mcp_response",
          success: false,
          error: "Daemon is shutting down",
        }) + "\n",
      ),
    );

    await expect(pending).rejects.not.toBeInstanceOf(DaemonShuttingDownError);
    await client.close();
  });

  test("classifies a structured overload response as retryable", async () => {
    const idGenerator = new CountingIdGenerator("req");
    const writes: string[] = [];
    const client = createConnectedClient(fakeTimer, idGenerator, writes);

    const pending = client.callTool("tapOn", {});
    (client as any).handleData(
      Buffer.from(
        JSON.stringify({
          id: "req-1",
          type: "mcp_response",
          success: false,
          error: "Retry after 250ms",
          overloadFailure: {
            code: "daemon_overloaded",
            retryable: true,
            retryAfterMs: 250,
            reason: "insufficient_forward_budget",
            queueWaitMs: 450,
            remainingTimeoutMs: 50,
          },
        }) + "\n",
      ),
    );

    const error = await pending.catch((cause: unknown) => cause);
    expect(error).toBeInstanceOf(McpOverloadError);
    expect(error).toMatchObject({ code: "daemon_overloaded" });
    expect((error as McpOverloadError).failure).toMatchObject({
      code: "daemon_overloaded",
      retryable: true,
      retryAfterMs: 250,
    });
    await client.close();
  });

  test.each([DAEMON_SESSION_NOT_FOUND_CODE, "other_failure", -32603, undefined])(
    "preserves response code %s and unchanged session error text",
    async (code) => {
      const client = createConnectedClient(fakeTimer, new CountingIdGenerator("req"), []);
      const pending = client.callDaemonMethod("daemon/sessionInfo", { sessionId: "missing" });
      (client as unknown as DaemonClientFrameInternals).handleData(
        Buffer.from(
          JSON.stringify({
            id: "req-1",
            type: "mcp_response",
            success: false,
            error: "Session not found: missing",
            ...(code === undefined ? {} : { code }),
          }) + "\n",
        ),
      );
      const error: unknown = await pending.catch((cause: unknown) => cause);
      expect(error).toMatchObject({ message: "Session not found: missing" });
      if (code === undefined) {
        expect(error).not.toHaveProperty("code");
      } else {
        expect(error).toMatchObject({ code });
      }
      await client.close();
    },
  );

  test("restores the daemon's original request failure cause", async () => {
    const idGenerator = new CountingIdGenerator("req");
    const writes: string[] = [];
    const client = createConnectedClient(fakeTimer, idGenerator, writes);

    const pending = client.callTool("listDevices", { platform: "android" });
    (client as any).handleData(
      Buffer.from(
        JSON.stringify({
          id: "req-1",
          type: "mcp_response",
          success: false,
          error: "The operation was aborted",
          requestFailureCause: {
            name: "Error",
            message: "Daemon MCP client disconnected",
          },
        }) + "\n",
      ),
    );

    const error = (await pending.catch((cause: unknown) => cause)) as Error;
    expect(error.cause).toBeInstanceOf(Error);
    expect(error.cause).toMatchObject({
      name: "Error",
      message: "Daemon MCP client disconnected",
    });
    await client.close();
  });
});
