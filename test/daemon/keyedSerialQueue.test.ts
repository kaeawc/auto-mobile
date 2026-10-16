import { describe, expect, test } from "bun:test";
import {
  runKeyedSerial,
  type KeyedSerialState,
} from "../../src/daemon/socketServer/keyedSerialQueue";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainMicrotasks } from "../helpers/fakeTimerStepping";

/** #11815: the per-key serial queue under the control socket's MCP forwards, with state injected. */
function fixture() {
  const events: string[] = [];
  const timer = new FakeTimer();
  const state: KeyedSerialState = {
    tails: new Map(),
    idleCloseKeys: new Map(),
    timer,
    onAcquired: (key) => events.push(`acquired:${key}`),
    onDrained: (key) => events.push(`drained:${key}`),
  };
  return { state, timer, events };
}

describe("runKeyedSerial", () => {
  test("forwards for one key run one at a time, in order", async () => {
    const { state, events } = fixture();
    const first = Promise.withResolvers<string>();
    const a = runKeyedSerial(state, "k", async () => {
      events.push("a:start");
      return await first.promise;
    });
    const b = runKeyedSerial(state, "k", async () => {
      events.push("b:start");
      return "b";
    });
    await drainMicrotasks(20);
    expect(events).toEqual(["a:start"]);
    first.resolve("a");
    expect(await a).toBe("a");
    expect(await b).toBe("b");
    expect(events).toEqual(["a:start", "b:start"]);
  });

  test("different keys do not wait for each other", async () => {
    const { state, events } = fixture();
    const gate = Promise.withResolvers<void>();
    const slow = runKeyedSerial(state, "one", async () => {
      await gate.promise;
    });
    await runKeyedSerial(state, "two", async () => {
      events.push("two:ran");
    });
    expect(events).toEqual(["two:ran"]);
    gate.resolve();
    await slow;
  });

  test("the tail is held while work is queued and cleared, re-arming idle close, once drained", async () => {
    const { state, events } = fixture();
    const gate = Promise.withResolvers<void>();
    const run = runKeyedSerial(state, "k", () => gate.promise, "client");
    await drainMicrotasks(20);
    expect(state.tails.has("k")).toBe(true);
    expect(events).toEqual(["acquired:client"]);
    gate.resolve();
    await run;
    await drainMicrotasks(20);
    expect(state.tails.size).toBe(0);
    expect(state.idleCloseKeys.size).toBe(0);
    expect(events).toEqual(["acquired:client", "drained:client"]);
  });

  test("a rejected forward still releases the key for the next one", async () => {
    const { state } = fixture();
    const failing = runKeyedSerial(state, "k", async () => {
      throw new Error("boom");
    });
    const next = runKeyedSerial(state, "k", async () => "ok");
    await expect(failing).rejects.toThrow("boom");
    expect(await next).toBe("ok");
  });

  test("a waiter that gave up does not let the next one run beside the holder", async () => {
    const { state, timer, events } = fixture();
    const holder = Promise.withResolvers<void>();
    const held = runKeyedSerial(state, "k", async () => {
      events.push("holder:start");
      await holder.promise;
    });
    const giveUp = runKeyedSerial(
      state,
      "k",
      async () => {
        events.push("waiter:ran");
      },
      undefined,
      { remainingMs: () => 50, timeoutError: (key) => new Error(`gave up on ${key}`) },
    );
    const caught = giveUp.then(
      () => undefined,
      (error: Error) => error.message,
    );
    const after = runKeyedSerial(state, "k", async () => {
      events.push("after:ran");
    });
    await drainMicrotasks(20);
    timer.advanceTime(50);
    await drainMicrotasks(20);
    expect(await caught).toBe("gave up on k");
    expect(events).toEqual(["holder:start"]);
    holder.resolve();
    await held;
    await after;
    expect(events).toEqual(["holder:start", "after:ran"]);
  });
});
