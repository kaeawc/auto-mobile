import { describe, expect, test } from "bun:test";
import { InMemoryTransport, type JSONRPCMessage } from "@modelcontextprotocol/server";
import { RawWire } from "./mcpTaskWire";

/** A server end that answers `tasks/get` as "working" for `workingPolls` polls, then "completed". */
async function wireSettlingAfter(workingPolls: number) {
  const [serverTransport, clientTransport] = InMemoryTransport.createLinkedPair();
  let polls = 0;
  serverTransport.onmessage = (message: JSONRPCMessage) => {
    if (!("id" in message) || !("method" in message)) {
      return;
    }
    polls++;
    const status = polls > workingPolls ? "completed" : "working";
    void serverTransport.send({ jsonrpc: "2.0", id: message.id, result: { status } });
  };
  await serverTransport.start();
  await clientTransport.start();
  return new RawWire(clientTransport);
}

describe("RawWire.settled", () => {
  test("keeps polling past 200 event-loop turns while real work is still in flight (#15059)", async () => {
    // A stop whose fs work needs more than 200 setImmediate turns under host load used to throw
    // "never settled"; the default poll is now bounded by a hang deadline, not a turn count.
    const wire = await wireSettlingAfter(450);
    const frame = await wire.settled("task-1");
    expect(frame.result?.status).toBe("completed");
  });

  test("a caller-supplied `between` keeps the 200-turn bound", async () => {
    const wire = await wireSettlingAfter(10_000);
    await expect(wire.settled("task-1", async () => {})).rejects.toThrow("never settled");
  });
});
