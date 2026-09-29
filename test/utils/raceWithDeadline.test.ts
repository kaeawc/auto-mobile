import { describe, expect, spyOn, test } from "bun:test";
import { ActionableError } from "../../src/models";
import { raceWithDeadline } from "../../src/utils/raceWithDeadline";
import { FakeTimer } from "../fakes/FakeTimer";

class TrackingTimer extends FakeTimer {
  scheduled = 0;

  override setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    this.scheduled++;
    return super.setTimeout(callback, ms);
  }
}

function deferred<T>(): {
  promise: Promise<T>;
  resolve: (value: T) => void;
  reject: (error: unknown) => void;
} {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function trackAbortListeners(signal: AbortSignal): () => void {
  const add = spyOn(signal, "addEventListener");
  const remove = spyOn(signal, "removeEventListener");
  return () => {
    const added = add.mock.calls.filter(([type]) => type === "abort");
    const removed = remove.mock.calls.filter(([type]) => type === "abort");
    expect(removed.length).toBe(added.length);
    for (const [type, listener] of added) {
      expect(
        removed.some(
          ([removedType, removedListener]) => removedType === type && removedListener === listener,
        ),
      ).toBe(true);
    }
    add.mockRestore();
    remove.mockRestore();
  };
}

describe("raceWithDeadline", () => {
  test("operation resolution clears the deadline and abort listener", async () => {
    const timer = new TrackingTimer();
    const controller = new AbortController();
    const assertListenersRemoved = trackAbortListeners(controller.signal);
    const work = deferred<string>();
    const raced = raceWithDeadline(work.promise, {
      timer,
      timeoutMs: 25,
      signal: controller.signal,
      label: "device lookup",
    });

    work.resolve("found");
    expect(await raced).toBe("found");
    expect(timer.getPendingTimeoutCount()).toBe(0);
    assertListenersRemoved();
    expect(() => controller.abort()).not.toThrow();
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("operation rejection preserves its error and cleans up", async () => {
    const timer = new TrackingTimer();
    const controller = new AbortController();
    const assertListenersRemoved = trackAbortListeners(controller.signal);
    const work = deferred<string>();
    const error = new Error("failed");
    const raced = raceWithDeadline(work.promise, {
      timer,
      timeoutMs: 25,
      signal: controller.signal,
      label: "device lookup",
    });

    work.reject(error);
    await expect(raced).rejects.toBe(error);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    assertListenersRemoved();
  });

  test("deadline rejection is labelled and cleans up", async () => {
    const timer = new TrackingTimer();
    const controller = new AbortController();
    const assertListenersRemoved = trackAbortListeners(controller.signal);
    const work = deferred<string>();
    const raced = raceWithDeadline(work.promise, {
      timer,
      timeoutMs: 25,
      signal: controller.signal,
      label: "device lookup",
    });

    timer.advanceTime(25);
    const error = await raced.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toContain("device lookup");
    expect((error as Error).message).toContain("25ms");
    expect(timer.getPendingTimeoutCount()).toBe(0);
    assertListenersRemoved();
    work.reject(new Error("late failure"));
    await Promise.resolve();
  });

  test("custom timeout error is preserved and cleanup runs once after rejection", async () => {
    const timer = new TrackingTimer();
    const controller = new AbortController();
    const timeoutError = new Error("custom deadline");
    const events: string[] = [];
    const raced = raceWithDeadline(deferred<string>().promise, {
      timer,
      timeoutMs: 25,
      signal: controller.signal,
      label: "custom lookup",
      timeoutError: () => {
        events.push("error");
        return timeoutError;
      },
      onTimeout: () => {
        events.push("cleanup");
        controller.abort();
      },
    });

    timer.advanceTime(25);
    expect(await raced.catch((error: unknown) => error)).toBe(timeoutError);
    expect(events).toEqual(["error", "cleanup"]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("completed operation does not call timeout hooks", async () => {
    const timer = new TrackingTimer();
    let calls = 0;
    expect(
      await raceWithDeadline(Promise.resolve("done"), {
        timer,
        timeoutMs: 25,
        label: "lookup",
        timeoutError: () => {
          calls++;
          return new Error("late");
        },
        onTimeout: () => {
          calls++;
        },
      }),
    ).toBe("done");
    timer.advanceTime(25);
    expect(calls).toBe(0);
  });

  test("default abort reason becomes a labelled ActionableError", async () => {
    const timer = new TrackingTimer();
    const controller = new AbortController();
    const assertListenersRemoved = trackAbortListeners(controller.signal);
    const raced = raceWithDeadline(deferred<string>().promise, {
      timer,
      timeoutMs: 25,
      signal: controller.signal,
      label: "device lookup",
      relabelDefaultAbort: true,
    });

    controller.abort();
    const error = await raced.catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(ActionableError);
    expect((error as Error).message).toContain("device lookup cancelled");
    expect(timer.getPendingTimeoutCount()).toBe(0);
    assertListenersRemoved();
  });

  test("default abort preserves the signal's AbortError reason", async () => {
    const controller = new AbortController();
    const raced = raceWithDeadline(deferred<string>().promise, {
      timer: new TrackingTimer(),
      signal: controller.signal,
      label: "device lookup",
    });

    controller.abort();
    expect(controller.signal.reason).toBeInstanceOf(DOMException);
    expect(controller.signal.reason.name).toBe("AbortError");
    expect(await raced.catch((reason: unknown) => reason)).toBe(controller.signal.reason);
  });

  test.each(["iOS physical-device discovery", "iOS hierarchy readiness"])(
    "%s keeps the raw AbortError shape used by downstream classifiers",
    async (label) => {
      const controller = new AbortController();
      const raced = raceWithDeadline(deferred<string>().promise, {
        timer: new TrackingTimer(),
        signal: controller.signal,
        label,
        relabelDefaultAbort: false,
      });

      controller.abort();
      const error = await raced.catch((reason: unknown) => reason);
      expect(error).toBe(controller.signal.reason);
      expect(error).toBeInstanceOf(DOMException);
      expect((error as DOMException).name).toBe("AbortError");
    },
  );

  test.each([false, true])(
    "explicit abort reason passes through unchanged (relabel=%s)",
    async (relabelDefaultAbort) => {
      const timer = new TrackingTimer();
      const controller = new AbortController();
      const assertListenersRemoved = trackAbortListeners(controller.signal);
      const raced = raceWithDeadline(deferred<string>().promise, {
        timer,
        timeoutMs: 25,
        signal: controller.signal,
        label: "device lookup",
        relabelDefaultAbort,
      });
      const reason = new Error("custom");

      controller.abort(reason);
      expect(await raced.catch((error: unknown) => error)).toBe(reason);
      expect(timer.getPendingTimeoutCount()).toBe(0);
      assertListenersRemoved();
    },
  );

  test("undefined abort reason uses the old AbortError fallback", async () => {
    const controller = new AbortController();
    controller.abort();
    Object.defineProperty(controller.signal, "reason", { value: undefined });

    const error = await raceWithDeadline(Promise.resolve("late"), {
      timer: new TrackingTimer(),
      signal: controller.signal,
      label: "device lookup",
    }).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect((error as DOMException).message).toBe("The operation was aborted.");
  });

  test("already-aborted default reason never starts a timer or adds a listener", async () => {
    const timer = new TrackingTimer();
    const controller = new AbortController();
    controller.abort();
    const assertListenersRemoved = trackAbortListeners(controller.signal);

    const raced = raceWithDeadline(Promise.resolve("late"), {
      timer,
      timeoutMs: 25,
      signal: controller.signal,
      label: "device lookup",
    });
    expect(timer.scheduled).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    const error = await raced.catch((reason: unknown) => reason);
    expect(error).toBe(controller.signal.reason);
    expect(error).toBeInstanceOf(DOMException);
    expect((error as DOMException).name).toBe("AbortError");
    expect(timer.scheduled).toBe(0);
    assertListenersRemoved();
  });

  test("already-aborted explicit reason is preserved without starting a timer", async () => {
    const timer = new TrackingTimer();
    const controller = new AbortController();
    const reason = new Error("custom");
    controller.abort(reason);
    const assertListenersRemoved = trackAbortListeners(controller.signal);

    const raced = raceWithDeadline(Promise.resolve("late"), {
      timer,
      timeoutMs: 25,
      signal: controller.signal,
      label: "device lookup",
    });
    expect(timer.scheduled).toBe(0);
    expect(timer.getPendingTimeoutCount()).toBe(0);
    expect(await raced.catch((error: unknown) => error)).toBe(reason);
    expect(timer.scheduled).toBe(0);
    assertListenersRemoved();
  });

  test("omitting a deadline does not start a timer", async () => {
    const timer = new TrackingTimer();
    expect(await raceWithDeadline(Promise.resolve("done"), { timer, label: "lookup" })).toBe(
      "done",
    );
    expect(timer.scheduled).toBe(0);
  });
});
