import { describe, expect, test } from "bun:test";
import { TransportAXBridgeClient } from "../../../src/utils/ios/AXBridgeClient";
import { FakeAXBridgeTransport } from "../../fakes/FakeAXBridgeTransport";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../fakes/FakeTimer";

function setup() {
  const transport = new FakeAXBridgeTransport();
  const timer = new FakeTimer();
  const client = new TransportAXBridgeClient(
    transport,
    new FakeIdGenerator(["a", "b"]),
    timer,
    1000,
  );
  return { transport, timer, client };
}

describe("TransportAXBridgeClient", () => {
  test("sends an invoke-action line and resolves on ok", async () => {
    const { transport, client } = setup();
    const done = client.invokeAction({ actionName: "Name:Edit mode\nTarget:0x0", elementId: "x" });
    expect(JSON.parse(transport.sent[0])).toEqual({
      id: "a",
      command: "invoke-action",
      actionName: "Name:Edit mode\nTarget:0x0",
      elementId: "x",
    });
    transport.emitLine('{"id":"a","ok":true}');
    await done;
  });

  test("rejects with the typed bridge error", async () => {
    const { transport, client } = setup();
    const done = client.invokeAction({ actionName: "n", elementDesc: "d" });
    transport.emitLine(
      '{"id":"a","ok":false,"error":{"code":"accessibility_not_trusted","message":"grant it"}}',
    );
    await expect(done).rejects.toThrow("accessibility_not_trusted: grant it");
  });

  test("routes out-of-order replies by id and ignores non-protocol lines", async () => {
    const { transport, client } = setup();
    const first = client.invokeAction({ actionName: "n", elementId: "1" });
    const second = client.invokeAction({ actionName: "n", elementId: "2" });
    transport.emitLine("diagnostic noise");
    transport.emitLine('{"id":"b","ok":true}');
    await second;
    transport.emitLine('{"id":"a","ok":true}');
    await first;
  });

  test("times out via the injected timer", async () => {
    const { timer, client } = setup();
    const done = client.invokeAction({ actionName: "n", elementId: "1" });
    timer.advanceTime(1000);
    await expect(done).rejects.toThrow("did not reply within 1000 ms");
  });

  test("process exit fails pending requests", async () => {
    const { transport, client } = setup();
    const done = client.invokeAction({ actionName: "n", elementId: "1" });
    transport.emitExit();
    await expect(done).rejects.toThrow("exited");
  });

  test("close rejects pending, closes the transport once, and blocks new calls", async () => {
    const { transport, client } = setup();
    const done = client.invokeAction({ actionName: "n", elementId: "1" });
    client.close();
    client.close();
    await expect(done).rejects.toThrow("closed");
    expect(transport.closeCalls).toBe(1);
    await expect(client.invokeAction({ actionName: "n", elementId: "1" })).rejects.toThrow(
      "closed",
    );
  });
});

test("an exited transport rejects future actions immediately", async () => {
  const { transport, client, timer } = setup();
  transport.emitExit();
  await expect(client.invokeAction({ actionName: "Edit" })).rejects.toThrow(
    "AXBridge process exited",
  );
  expect(transport.sent).toEqual([]);
  expect(timer.getPendingTimeouts()).toEqual([]);
});

test("send failure clears the request timer and returns an actionable error", async () => {
  class BrokenTransport extends FakeAXBridgeTransport {
    override send(): void {
      throw new Error("broken pipe");
    }
  }
  const timer = new FakeTimer();
  const client = new TransportAXBridgeClient(
    new BrokenTransport(),
    new FakeIdGenerator(["a"]),
    timer,
  );
  await expect(client.invokeAction({ actionName: "Edit" })).rejects.toThrow(
    "Could not send the AXBridge action",
  );
  expect(timer.getPendingTimeouts()).toEqual([]);
});
