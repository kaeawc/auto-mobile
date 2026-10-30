import { describe, expect, test } from "bun:test";
import { DaemonClient, DaemonUnavailableError } from "../../src/daemon/client/client";
import { FakeDaemonClient } from "../fakes/FakeDaemonClient";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeSocket } from "../fakes/FakeNetServer";
import { FakeTimer } from "../fakes/FakeTimer";

// #11868: semantics the fake must share with src/daemon/client/client.ts. The real client is driven
// hermetically through testHooks.attachSocket + FakeSocket (no real socket, pid file or daemon).

function realClient(): { client: DaemonClient; hangUp: () => void } {
  const client = new DaemonClient("/fake/socket", 1000, new FakeTimer(), {}, null, {
    idGenerator: new FakeIdGenerator(["p"]),
    platformOverride: "darwin",
    maxInboundFrameBytes: 64,
  });
  client.testHooks.attachSocket(new FakeSocket());
  // An oversized frame closes the connection through handleSocketClosed (client.ts ~L990).
  const hangUp = () => client.testHooks.simulateIncomingData(Buffer.from("x".repeat(65) + "\n"));
  return { client, hangUp };
}

function outcome(run: () => void): string {
  try {
    run();
    return "returned";
  } catch (error) {
    return (error as Error).message;
  }
}

/** Registers a throwing handler then a second one; returns the calls they record. */
function registerHandlers(client: {
  onConnectionClosed?: (handler: () => void) => () => void;
}): string[] {
  const calls: string[] = [];
  client.onConnectionClosed!(() => {
    calls.push("first");
    throw new Error("handler failed");
  });
  client.onConnectionClosed!(() => calls.push("second"));
  return calls;
}

describe("connection-closed handlers (client.ts handleSocketClosed ~L990)", () => {
  test("a throwing handler propagates and stops the chain, in real and fake alike", () => {
    const real = realClient();
    const realCalls = registerHandlers(real.client);
    const realOutcome = outcome(real.hangUp);

    const fake = new FakeDaemonClient();
    const fakeCalls = registerHandlers(fake);
    const fakeOutcome = outcome(() => fake.emitConnectionClosed());

    expect(realCalls).toEqual(["first"]);
    expect(fakeCalls).toEqual(realCalls);
    expect(fakeOutcome).toBe(realOutcome);
  });
});

describe("FakeDaemonClient abort (client.ts rechecks signal.aborted after listening, ~L1457)", () => {
  test("a signal aborted while the hook is pending rejects instead of hanging", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted synchronously");
    const fake = new FakeDaemonClient({
      onCallTool: () => {
        controller.abort(reason);
        return new Promise<void>(() => {});
      },
    });
    const call = fake.callTool("observe", {}, undefined, undefined, { signal: controller.signal });
    expect(await call.catch((error: unknown) => error)).toBe(reason);
  });

  test("a daemon method aborted synchronously inside its hook rejects as unavailable", async () => {
    const controller = new AbortController();
    const reason = new Error("aborted synchronously");
    const fake = new FakeDaemonClient({
      onCallDaemonMethod: () => {
        controller.abort(reason);
        return new Promise<void>(() => {});
      },
    });
    const refused = await fake
      .callDaemonMethod("daemon/x", {}, { signal: controller.signal })
      .catch((error: unknown) => error);
    expect(refused).toBeInstanceOf(DaemonUnavailableError);
    expect((refused as Error).cause).toBe(reason);
  });
});
