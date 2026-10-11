import { describe, expect, test } from "bun:test";
import { runOperationWithinDeadline } from "../../src/server/deviceTools";
import { FakeTimer } from "../fakes/FakeTimer";

// #11565: losing the race does not stop the operation. One that commits something for its caller
// registers an undo, which must run exactly when the caller got an error instead of the result.

const spin = async (turns = 50): Promise<void> => {
  for (let turn = 0; turn < turns; turn++) {
    await Promise.resolve();
  }
};

const timeoutError = () => new Error("deadline passed");

/** Race a gated operation that registers an undo; report what the caller and the undo saw. */
function start(signal?: AbortSignal, undoOutcome: () => Promise<void> = async () => {}) {
  const timer = new FakeTimer();
  const gate = Promise.withResolvers<string>();
  const undone: string[] = [];
  const orphans: Promise<unknown>[] = [];
  const caller = runOperationWithinDeadline<string>(
    timer,
    timer.now() + 1_000,
    signal,
    timeoutError,
    async (_signal, undoIfUndelivered) => {
      undoIfUndelivered(async (result) => {
        undone.push(result);
        await undoOutcome();
      });
      return await gate.promise;
    },
    (pending) => orphans.push(pending),
  ).then(
    (result) => ({ result }),
    (error: unknown) => ({ error }),
  );
  return { timer, gate, undone, orphans, caller };
}

describe("runOperationWithinDeadline undelivered results", () => {
  test("a delivered result is never undone", async () => {
    const { gate, undone, orphans, caller } = start(new AbortController().signal);

    gate.resolve("session");

    expect(await caller).toEqual({ result: "session" });
    await spin();
    expect(undone).toEqual([]);
    expect(orphans).toEqual([]);
  });

  test("a result produced after the request was cancelled is undone once", async () => {
    const controller = new AbortController();
    const cancelled = new Error("client cancelled");
    const { gate, undone, orphans, caller } = start(controller.signal);

    controller.abort(cancelled);
    expect(await caller).toEqual({ error: cancelled });
    expect(undone).toEqual([]);
    gate.resolve("session");
    await spin();

    expect(undone).toEqual(["session"]);
    expect(orphans.length).toBe(1);
  });

  test("a result produced after the deadline passed is undone once", async () => {
    const { timer, gate, undone, caller } = start();

    timer.advanceTime(1_000);
    expect(await caller).toMatchObject({ error: { message: "deadline passed" } });
    gate.resolve("session");
    await spin();

    expect(undone).toEqual(["session"]);
  });

  test("the orphaned operation stays pending until its undo has finished", async () => {
    const controller = new AbortController();
    const undo = Promise.withResolvers<void>();
    const { gate, orphans, caller } = start(controller.signal, () => undo.promise);
    controller.abort(new Error("client cancelled"));
    await caller;
    let orphanSettled = false;
    void orphans[0].finally(() => {
      orphanSettled = true;
    });

    gate.resolve("session");
    await spin();
    expect(orphanSettled).toBe(false);
    undo.resolve();
    await spin();

    expect(orphanSettled).toBe(true);
  });

  test("a failing undo is reported without failing the orphaned operation", async () => {
    const controller = new AbortController();
    const { gate, undone, orphans, caller } = start(controller.signal, () =>
      Promise.reject(new Error("release failed")),
    );
    controller.abort(new Error("client cancelled"));
    await caller;

    gate.resolve("session");

    expect(await orphans[0]).toBe("session");
    expect(undone).toEqual(["session"]);
  });

  test("an operation that fails after the request was cancelled has nothing to undo", async () => {
    const controller = new AbortController();
    const { gate, undone, caller } = start(controller.signal);
    controller.abort(new Error("client cancelled"));
    await caller;

    gate.reject(new Error("bind failed"));
    await spin();

    expect(undone).toEqual([]);
  });

  test.each(Array.from({ length: 16 }, (_, turns) => turns))(
    "a cancel %i microtasks after the result either delivers it or undoes it, never both or neither",
    async (turns) => {
      const controller = new AbortController();
      const { gate, undone, caller } = start(controller.signal);

      gate.resolve("session");
      await spin(turns);
      controller.abort(new Error("client cancelled"));
      const outcome = await caller;
      await spin();

      expect(undone).toEqual("result" in outcome ? [] : ["session"]);
    },
  );
});
