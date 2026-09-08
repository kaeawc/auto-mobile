import { describe, expect, test, beforeEach } from "bun:test";
import { Duplex } from "node:stream";
import { DaemonClient, DaemonShuttingDownError } from "../../src/daemon/client";
import { DAEMON_SHUTTING_DOWN_ERROR_MESSAGE } from "../../src/daemon/constants";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

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

  test("classifies a quiescing daemon response as retryable", async () => {
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
          error: DAEMON_SHUTTING_DOWN_ERROR_MESSAGE,
        }) + "\n",
      ),
    );

    await expect(pending).rejects.toBeInstanceOf(DaemonShuttingDownError);
    await client.close();
  });
});
