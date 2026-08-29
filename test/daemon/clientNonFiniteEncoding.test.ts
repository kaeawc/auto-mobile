import { describe, expect, test, beforeEach } from "bun:test";
import { Duplex } from "node:stream";
import { DaemonClient } from "../../src/daemon/client";
import { CountingIdGenerator } from "../../src/utils/IdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

// Issue #5854 §2: a non-finite tool-call argument must reach the daemon as a
// JSON-safe sentinel, not `null`, so the request log and schema see the real
// value. This pins the wire encoding at the client boundary.

function createCapturingSocket(writes: string[]): Duplex {
  return new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      writes.push(chunk.toString());
      callback();
    },
  });
}

function createConnectedClient(fakeTimer: FakeTimer, writes: string[]): DaemonClient {
  const client = new DaemonClient(
    "/fake/socket",
    1000,
    fakeTimer,
    {},
    null,
    new CountingIdGenerator("req"),
  );
  (client as unknown as { connected: boolean }).connected = true;
  (client as unknown as { socket: Duplex }).socket = createCapturingSocket(writes);
  return client;
}

function firstFrame(writes: string[]): Record<string, unknown> {
  const line = writes
    .join("")
    .split("\n")
    .find((candidate) => candidate.trim().length > 0);
  return JSON.parse(line!);
}

describe("DaemonClient encodes non-finite tool arguments on the wire", () => {
  let fakeTimer: FakeTimer;

  beforeEach(() => {
    fakeTimer = new FakeTimer();
  });

  test("Infinity/-Infinity/NaN are written as sentinels, not null", async () => {
    const writes: string[] = [];
    const client = createConnectedClient(fakeTimer, writes);

    const pending = client
      .callTool("tapOn", { duration: Infinity, back: -Infinity, ratio: NaN, ok: 3 })
      .catch(() => {});

    const frame = firstFrame(writes) as {
      params: { arguments: Record<string, unknown> };
    };
    const args = frame.params.arguments;
    expect(args.duration).toEqual({ __autoMobileNonFinite__: "Infinity" });
    expect(args.back).toEqual({ __autoMobileNonFinite__: "-Infinity" });
    expect(args.ratio).toEqual({ __autoMobileNonFinite__: "NaN" });
    // A finite sibling is untouched, and nothing became null.
    expect(args.ok).toBe(3);
    expect(JSON.stringify(args)).not.toContain("null");

    await client.close();
    await pending;
  });
});
