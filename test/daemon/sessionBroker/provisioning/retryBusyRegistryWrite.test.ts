import { expect, spyOn, test } from "bun:test";
import { BindingDiscoveryIncompleteError } from "../../../../src/daemon/sessionBroker/provisioning/refusal";
import { FakeTimer } from "../../../fakes/FakeTimer";
import { drainMicrotasks, drainUntil } from "../../../helpers/fakeTimerStepping";
import { retryBusyRegistryWrite } from "../registry/fixtures/retryBusyRegistryWrite";

const busyError = () => Object.assign(new Error("database is locked"), { code: "SQLITE_BUSY" });

test("lands first try without scheduling a timer", async () => {
  const timer = new FakeTimer();
  const scheduled = spyOn(timer, "setTimeout");
  try {
    expect(await retryBusyRegistryWrite(async () => "landed", { timer })).toEqual({
      result: "landed",
      attempts: 1,
    });
    expect(scheduled).not.toHaveBeenCalled();
  } finally {
    scheduled.mockRestore();
  }
});

for (const discovery of [false, true]) {
  test(`${discovery ? "retryable discovery" : "SQLite busy"} twice then lands only after fake time advances`, async () => {
    const timer = new FakeTimer();
    const error = discovery ? new BindingDiscoveryIncompleteError("busy") : busyError();
    let calls = 0;
    const pending = retryBusyRegistryWrite(
      async () => {
        calls++;
        if (calls <= 2) {
          // A blocked retry must extend the quiet period as production callers do.
          if (calls === 2) {
            timer.setCurrentTime(timer.now() + 100);
          }
          throw error;
        }
        return "landed";
      },
      { timer },
    );
    await drainUntil(() => timer.getPendingTimeoutCount() === 1, {
      description: "first retry wait",
    });
    expect(calls).toBe(1);
    timer.advanceTime(24);
    await drainMicrotasks(30);
    expect(calls).toBe(1);
    timer.advanceTime(1);
    await drainUntil(() => timer.getPendingTimeoutCount() === 1 && calls === 2, {
      description: "second retry wait",
    });
    timer.advanceTime(50);
    await drainMicrotasks(30);
    expect(calls).toBe(2); // Backoff elapsed, but the failed turn's quiet period has not.
    timer.advanceTime(49);
    await drainMicrotasks(30);
    expect(calls).toBe(2);
    timer.advanceTime(1);
    expect(await pending).toEqual({ result: "landed", attempts: 3 });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
}

test("a non-busy error is rethrown immediately without waiting", async () => {
  const timer = new FakeTimer();
  const scheduled = spyOn(timer, "setTimeout");
  const error = new Error("invalid binding");
  let calls = 0;
  try {
    await expect(
      retryBusyRegistryWrite(
        async () => {
          calls++;
          throw error;
        },
        { timer },
      ),
    ).rejects.toBe(error);
    expect(calls).toBe(1);
    expect(scheduled).not.toHaveBeenCalled();
  } finally {
    scheduled.mockRestore();
  }
});

test("exhaustion preserves the last busy error and clears all timers", async () => {
  const timer = new FakeTimer();
  const error = busyError();
  let calls = 0;
  const pending = retryBusyRegistryWrite(
    async () => {
      calls++;
      throw error;
    },
    { timer, maxAttempts: 3 },
  ).catch((caught: unknown) => caught);
  await drainUntil(() => timer.getPendingTimeoutCount() === 1, { description: "first retry wait" });
  timer.advanceTime(25);
  await drainUntil(() => timer.getPendingTimeoutCount() === 1 && calls === 2, {
    description: "last retry wait",
  });
  timer.advanceTime(50);
  expect(await pending).toBe(error);
  expect(calls).toBe(3);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});
