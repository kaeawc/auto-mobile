import { describe, expect, test } from "bun:test";
import {
  TASK_BINDING_CAPACITY,
  TASK_BINDING_IDLE_MS,
  TaskSessionBindings,
} from "../../../src/daemon/proxy/TaskSessionBindings";
import { FakeTimer } from "../../fakes/FakeTimer";

/*
 * The device-binding tasks a proxy waits on (#4668): each binds at most once, from a completed
 * result, and every way a task stops waiting releases what it held exactly once.
 */

function harness(bind: (context: string, result: unknown) => Promise<void> = async () => {}) {
  const timer = new FakeTimer();
  const bound: Array<[string, unknown]> = [];
  const released: string[] = [];
  const retained: string[] = [];
  const bindings = new TaskSessionBindings<string>({
    timer,
    bind: async (context, result) => {
      bound.push([context, result]);
      await bind(context, result);
    },
    retain: (context) => retained.push(context),
    release: (context) => released.push(context),
  });
  return { timer, bindings, bound, released, retained };
}

describe("TaskSessionBindings (#4668)", () => {
  test("a completed task binds its result once and releases once", async () => {
    const { bindings, bound, released } = harness();
    bindings.defer("t", "ctx");

    await bindings.settle("t", { status: "working" });
    await bindings.settle("t", { status: "completed", result: { n: 1 } });
    await bindings.settle("t", { status: "completed", result: { n: 2 } });

    expect(bound).toEqual([["ctx", { n: 1 }]]);
    expect(released).toEqual(["ctx"]);
    expect(bindings.isPending("t")).toBe(false);
  });

  test("a binding's error reaches every poll of that task, and it is not bound again", async () => {
    const { bindings, bound, released } = harness(async () => {
      throw new Error("session released");
    });
    bindings.defer("t", "ctx");

    await expect(bindings.settle("t", { status: "completed", result: {} })).rejects.toThrow(
      "session released",
    );
    await expect(bindings.settle("t", { status: "completed", result: {} })).rejects.toThrow(
      "session released",
    );
    expect(bound).toHaveLength(1);
    expect(released).toEqual(["ctx"]);
  });

  test.each(["failed", "cancelled"])("a %s task binds nothing", async (status) => {
    const { bindings, bound, released } = harness();
    bindings.defer("t", "ctx");

    await bindings.settle("t", { status });
    await bindings.settle("t", { status: "completed", result: {} });

    expect(bound).toEqual([]);
    expect(released).toEqual(["ctx"]);
  });

  test("a forgotten task binds nothing; a bound one is not forgotten", async () => {
    const { bindings, bound, released } = harness();
    bindings.defer("gone", "a");
    bindings.defer("done", "b");
    await bindings.settle("done", { status: "completed", result: {} });

    bindings.forget("gone");
    bindings.forget("done");
    await bindings.settle("gone", { status: "completed", result: {} });

    expect(bound).toEqual([["b", {}]]);
    expect(released).toEqual(["b", "a"]);
  });

  test("an unpolled task is abandoned after the daemon's retention; a polled one is kept", async () => {
    const { timer, bindings, released } = harness();
    bindings.defer("idle", "a");
    bindings.defer("polled", "b");

    timer.advanceTime(TASK_BINDING_IDLE_MS);
    await bindings.settle("polled", { status: "working" });
    timer.advanceTime(1);
    await bindings.settle("polled", { status: "working" });

    expect(bindings.isPending("idle")).toBe(false);
    expect(bindings.isPending("polled")).toBe(true);
    expect(released).toEqual(["a"]);
  });

  test("past capacity the oldest waiting task is evicted", () => {
    const { bindings, released } = harness();
    for (let index = 0; index <= TASK_BINDING_CAPACITY; index++) {
      bindings.defer(`t${index}`, `c${index}`);
    }

    expect(released).toEqual(["c0"]);
    expect(bindings.isPending("t0")).toBe(false);
    expect(bindings.isPending(`t${TASK_BINDING_CAPACITY}`)).toBe(true);
  });

  test("a relayed tasks/get settles the task; a JSON-RPC error forgets it; other methods pass", async () => {
    const { bindings, bound, released, retained } = harness();
    bindings.defer("ok", "a");
    bindings.defer("gone", "b");
    const notFound = Object.assign(new Error("Task not found"), {
      jsonRpcError: { code: -32602, message: "Task not found" },
    });

    await bindings.relayed("tasks/cancel", { taskId: "ok" }, Promise.resolve({}));
    const answer = { status: "completed", result: { n: 1 } };
    expect(await bindings.relayed("tasks/get", { taskId: "ok" }, Promise.resolve(answer))).toBe(
      answer,
    );
    await expect(
      bindings.relayed("tasks/get", { taskId: "gone" }, Promise.reject(notFound)),
    ).rejects.toBe(notFound);

    expect(retained).toEqual(["a", "b"]);
    expect(bound).toEqual([["a", { n: 1 }]]);
    expect(released).toEqual(["a", "b"]);
  });

  test("clear releases every waiting task", () => {
    const { bindings, released } = harness();
    bindings.defer("a", "a");
    bindings.defer("b", "b");

    bindings.clear();

    expect(released).toEqual(["a", "b"]);
    expect(bindings.isPending("a")).toBe(false);
  });
});
