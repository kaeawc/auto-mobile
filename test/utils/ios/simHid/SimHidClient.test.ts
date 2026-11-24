import { describe, expect, test } from "bun:test";
import { TransportSimHidClient } from "../../../../src/utils/ios/simHid/SimHidClient";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { FakeSimHidTransport } from "./SimHidFakes";

function setup() {
  const transport = new FakeSimHidTransport();
  const timer = new FakeTimer();
  const client = new TransportSimHidClient(transport, new FakeIdGenerator(["a", "b"]), timer);
  return { transport, timer, client };
}

describe("TransportSimHidClient", () => {
  test("writes one JSON line per command, one at a time, and resolves its ack by id", async () => {
    const { transport, client } = setup();
    const first = client.send({ cmd: "button", button: "home" }, 1000);
    const second = client.send({ cmd: "key", key: "tab", modifiers: [] }, 1000);
    expect(transport.sent.map((line) => JSON.parse(line))).toEqual([
      { id: "a", cmd: "button", button: "home" },
    ]);
    transport.reply("not json");
    transport.reply(JSON.stringify({ id: "a", ok: true, sent: true, elapsedMs: 1 }));
    expect(transport.sent.map((line) => JSON.parse(line))[1]).toEqual({
      id: "b",
      cmd: "key",
      key: "tab",
      modifiers: [],
    });
    transport.reply(
      JSON.stringify({ id: "b", ok: false, sent: false, error: { code: "x", message: "y" } }),
    );
    expect(await first).toEqual({ status: "delivered", elapsedMs: 1 });
    expect(await second).toEqual({ status: "unavailable", reason: "sim-hid-helper x: y" });
  });

  test("a queued command's timeout starts when it is written", async () => {
    const { transport, timer, client } = setup();
    const swipe = client.send({ cmd: "button", button: "home" }, 3000);
    const queued = client.send({ cmd: "key", key: "tab", modifiers: [] }, 1000);
    let queuedOutcome: unknown;
    void queued.then((outcome) => {
      queuedOutcome = outcome;
    });
    timer.advanceTime(2500);
    transport.reply(JSON.stringify({ id: "a", ok: true, sent: true }));
    await swipe;
    timer.advanceTime(900);
    await Promise.resolve();
    expect(queuedOutcome).toBeUndefined();
    transport.reply(JSON.stringify({ id: "b", ok: true, sent: true }));
    expect((await queued).status).toBe("delivered");
  });

  test("a helper exit leaves never-written queued commands unavailable", async () => {
    const { transport, client } = setup();
    const written = client.send({ cmd: "button", button: "home" }, 1000);
    const queued = client.send({ cmd: "ping" }, 1000);
    transport.exit();
    expect((await written).status).toBe("indeterminate");
    expect((await queued).status).toBe("unavailable");
    expect(transport.sent).toHaveLength(1);
  });

  test("a long gesture that outlives its timeout is indeterminate, never unavailable", async () => {
    const { timer, client } = setup();
    const swipe = client.send(
      { cmd: "swipe", x: 1, y: 1, toX: 2, toY: 2, durationMs: 4000, width: 402, height: 874 },
      7000,
    );
    timer.advanceTime(7000);
    expect((await swipe).status).toBe("indeterminate");
  });

  test("a missing ack is indeterminate after the timeout", async () => {
    const { timer, client } = setup();
    const pending = client.send({ cmd: "button", button: "lock" }, 500);
    timer.advanceTime(500);
    expect(await pending).toEqual({
      status: "indeterminate",
      reason: "sim-hid-helper did not reply within 500 ms",
    });
  });

  test("a timeout retires the helper instead of writing the next command to it", async () => {
    const { transport, timer, client } = setup();
    const pending = client.send({ cmd: "button", button: "lock" }, 500);
    const queued = client.send({ cmd: "ping" }, 500);
    timer.advanceTime(500);
    expect((await pending).status).toBe("indeterminate");
    expect((await queued).status).toBe("unavailable");
    expect(transport.sent).toHaveLength(1);
    expect(transport.isClosed).toBe(true);
    expect(client.closed).toBe(true);
  });

  test("a helper exit settles pending commands as indeterminate and refuses later ones", async () => {
    const { transport, client } = setup();
    const pending = client.send({ cmd: "button", button: "home" }, 1000);
    transport.exit();
    expect((await pending).status).toBe("indeterminate");
    expect(client.closed).toBe(true);
    expect(await client.send({ cmd: "ping" }, 1000)).toEqual({
      status: "unavailable",
      reason: "sim-hid-helper has exited",
    });
  });

  test("beforeWrite runs after the queue wait; a throw writes nothing and the next command runs", async () => {
    const { transport, client } = setup();
    const first = client.send({ cmd: "button", button: "home" }, 1000);
    let checked = 0;
    const fenced = client.send({ cmd: "ping" }, 1000, () => {
      checked++;
      throw new Error("display changed");
    });
    const third = client.send({ cmd: "button", button: "lock" }, 1000);
    expect(checked).toBe(0);
    transport.reply(JSON.stringify({ id: "a", ok: true, sent: true }));
    await first;
    await expect(fenced).rejects.toThrow("display changed");
    expect(checked).toBe(1);
    expect(transport.sent.map((line) => JSON.parse(line).cmd)).toEqual(["button", "button"]);
    transport.reply(JSON.stringify({ id: "b", ok: true, sent: true }));
    expect((await third).status).toBe("delivered");
  });

  test("a failed write sent nothing", async () => {
    const { transport, client } = setup();
    transport.failWrites = true;
    expect((await client.send({ cmd: "ping" }, 1000)).status).toBe("unavailable");
  });

  test("onWritten fires after the line is written, before any reply, and not for a failed write", async () => {
    const { transport, client } = setup();
    const order: string[] = [];
    const pending = client.send({ cmd: "button", button: "lock" }, 1000, undefined, () =>
      order.push(`written:${transport.sent.length}`),
    );
    expect(order).toEqual(["written:1"]);
    transport.reply(
      JSON.stringify({ id: "a", ok: false, sent: false, error: { code: "x", message: "y" } }),
    );
    expect((await pending).status).toBe("unavailable");
    transport.failWrites = true;
    const failed = await client.send({ cmd: "button", button: "lock" }, 1000, undefined, () =>
      order.push("written-again"),
    );
    expect(failed.status).toBe("unavailable");
    expect(order).toEqual(["written:1"]);
  });
});
