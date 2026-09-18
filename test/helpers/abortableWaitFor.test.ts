import { describe, expect, test } from "bun:test";
import { FakeTimer } from "../fakes/FakeTimer";
import { waitFor } from "./abortableWaitFor";

describe("abortableWaitFor", () => {
  test("cancels and awaits an in-flight predicate when its deadline expires", async () => {
    const timer = new FakeTimer();
    let predicateSignal: AbortSignal | undefined;
    let fakeSubprocessSettled = false;

    const wait = waitFor(
      (signal) =>
        new Promise<boolean>((resolve) => {
          predicateSignal = signal;
          signal.addEventListener(
            "abort",
            () => {
              fakeSubprocessSettled = true;
              resolve(false);
            },
            { once: true },
          );
        }),
      "fixture did not recover",
      100,
      timer,
    );

    expect(predicateSignal).toBeDefined();
    expect(predicateSignal!.aborted).toBe(false);

    let waitError: unknown;
    const settled = wait.catch((error: unknown) => {
      waitError = error;
    });
    await timer.advanceTimeAsync(100);

    await settled;
    expect(waitError).toEqual(
      new Error(
        "fixture did not recover did not complete within 100ms total (last poll remainder: fixture did not recover did not complete within 100ms — bounded real-I/O deadline hit)",
      ),
    );
    expect(predicateSignal!.aborted).toBe(true);
    expect(fakeSubprocessSettled).toBe(true);
  });

  test("reports the total timeout after multiple poll iterations", async () => {
    const timer = new FakeTimer();
    let polls = 0;

    const wait = waitFor(
      (signal) => {
        polls += 1;
        if (polls < 3) {
          return Promise.resolve(false);
        }
        return new Promise<boolean>((resolve) => {
          signal.onabort = () => resolve(false);
        });
      },
      "fixture did not recover",
      300,
      timer,
    );

    let waitError: unknown;
    const settled = wait.catch((error: unknown) => {
      waitError = error;
    });
    await new Promise<void>((resolve) => setImmediate(resolve));
    await timer.advanceTimeAsync(400);

    await settled;
    expect(polls).toBeGreaterThanOrEqual(3);
    expect(waitError).toBeInstanceOf(Error);
    expect((waitError as Error).message).toContain("300ms total");
    expect((waitError as Error).message).toContain("last poll remainder:");
  });
});
