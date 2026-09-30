import { describe, expect, spyOn, test } from "bun:test";
import { ActionableError } from "../../src/models";
import { runPhaseWithSettlement } from "../../src/utils/runPhaseWithSettlement";
import { FakeTimer } from "../fakes/FakeTimer";

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function options(timer: FakeTimer, signal?: AbortSignal) {
  return {
    timer,
    signal,
    timeoutMs: 20,
    graceMs: 10,
    label: "runner setup",
    timeoutError: () => new Error("setup deadline"),
  };
}

describe("runPhaseWithSettlement", () => {
  test("aborts on timeout and waits for a cooperative operation to settle", async () => {
    const timer = new FakeTimer();
    let phaseSignal!: AbortSignal;
    let settled = false;
    const phase = runPhaseWithSettlement(options(timer), (signal) => {
      phaseSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal.addEventListener(
          "abort",
          () => {
            timer.setTimeout(() => {
              settled = true;
              reject(signal.reason);
            }, 5);
          },
          { once: true },
        );
      });
    });
    timer.advanceTime(20);
    await Promise.resolve();
    expect(phaseSignal.aborted).toBe(true);
    timer.advanceTime(5);
    await expect(phase).rejects.toThrow("setup deadline");
    expect(settled).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("does not start an already cancelled phase", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    controller.abort();
    let started = false;
    await expect(
      runPhaseWithSettlement(options(timer, controller.signal), async () => {
        started = true;
      }),
    ).rejects.toBe(controller.signal.reason);
    expect(started).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("relabels a mid-phase default abort after settlement", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    let phaseSignal!: AbortSignal;
    const phase = runPhaseWithSettlement(
      {
        ...options(timer, controller.signal),
        defaultAbortError: () => new ActionableError("runner setup cancelled"),
      },
      (signal) => {
        phaseSignal = signal;
        return new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        });
      },
    );
    controller.abort();
    await expect(phase).rejects.toBeInstanceOf(ActionableError);
    await expect(phase).rejects.toThrow("runner setup cancelled");
    expect(phaseSignal.aborted).toBe(true);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("bounds settlement wait when an operation ignores abort", async () => {
    const timer = new FakeTimer();
    const work = deferred<string>();
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    try {
      const phase = runPhaseWithSettlement(options(timer), () => work.promise);
      timer.advanceTime(20);
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(timer.getPendingTimeouts()).toEqual([10]);
      timer.advanceTime(10);
      await expect(phase).rejects.toThrow("setup deadline");
      expect(timer.getPendingTimeoutCount()).toBe(0);
      work.reject(new Error("late failure"));
      await new Promise<void>((resolve) => setImmediate(resolve));
      expect(unhandled).toEqual([]);
    } finally {
      process.off("unhandledRejection", onUnhandled);
    }
  });

  test("uses microtasks for zero grace and retains a cooperative cleanup failure", async () => {
    const timer = new FakeTimer();
    const cleanupFailure = new Error("readiness cleanup failed");
    const phase = runPhaseWithSettlement(
      { ...options(timer), graceMs: 0, preferOperationFailureOnTimeout: true },
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => queueMicrotask(() => reject(cleanupFailure)), {
            once: true,
          });
        }),
    );
    timer.advanceTime(20);
    await expect(phase).rejects.toBe(cleanupFailure);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each(["success", "throw", "timeout", "abort-before-start"] as const)(
    "removes external listeners after %s",
    async (path) => {
      const timer = new FakeTimer();
      const controller = new AbortController();
      const add = spyOn(controller.signal, "addEventListener");
      const remove = spyOn(controller.signal, "removeEventListener");
      try {
        if (path === "abort-before-start") {
          controller.abort();
          await expect(
            runPhaseWithSettlement(options(timer, controller.signal), async () => "unused"),
          ).rejects.toBe(controller.signal.reason);
        } else if (path === "success") {
          await expect(
            runPhaseWithSettlement(options(timer, controller.signal), async () => "ready"),
          ).resolves.toBe("ready");
        } else if (path === "throw") {
          const failure = new Error("operation failed");
          await expect(
            runPhaseWithSettlement(options(timer, controller.signal), async () => {
              throw failure;
            }),
          ).rejects.toBe(failure);
        } else {
          const phase = runPhaseWithSettlement(
            options(timer, controller.signal),
            (signal) =>
              new Promise<never>((_resolve, reject) => {
                signal.addEventListener("abort", () => reject(signal.reason), { once: true });
              }),
          );
          timer.advanceTime(20);
          await expect(phase).rejects.toThrow("setup deadline");
        }
        const added = add.mock.calls.filter(([type]) => type === "abort");
        const removed = remove.mock.calls.filter(([type]) => type === "abort");
        expect(removed.length).toBe(added.length);
        for (const [, listener] of added) {
          expect(removed.some(([, removedListener]) => removedListener === listener)).toBe(true);
        }
        expect(timer.getPendingTimeoutCount()).toBe(0);
      } finally {
        add.mockRestore();
        remove.mockRestore();
      }
    },
  );

  test("preserves explicit abort reasons and removes both abort listeners", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const add = spyOn(controller.signal, "addEventListener");
    const remove = spyOn(controller.signal, "removeEventListener");
    const reason = new Error("caller cancelled");
    const phase = runPhaseWithSettlement(
      options(timer, controller.signal),
      (signal) =>
        new Promise<never>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(signal.reason), { once: true });
        }),
    );
    controller.abort(reason);
    await expect(phase).rejects.toBe(reason);
    const added = add.mock.calls.filter(([type]) => type === "abort");
    const removed = remove.mock.calls.filter(([type]) => type === "abort");
    expect(removed.length).toBe(added.length);
    for (const [, listener] of added) {
      expect(removed.some(([, removedListener]) => removedListener === listener)).toBe(true);
    }
    expect(timer.getPendingTimeoutCount()).toBe(0);
    add.mockRestore();
    remove.mockRestore();
  });
});
