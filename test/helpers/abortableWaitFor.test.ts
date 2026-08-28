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
        "fixture did not recover did not complete within 100ms — bounded real-I/O deadline hit",
      ),
    );
    expect(predicateSignal!.aborted).toBe(true);
    expect(fakeSubprocessSettled).toBe(true);
  });
});
