import { expect, test } from "bun:test";
import { ActionableError } from "../../../src/models";
import {
  forceStopHostRecorder,
  HOST_RECORDER_INTERRUPT_TIMEOUT_MS,
  HOST_RECORDER_KILL_TIMEOUT_MS,
  HOST_RECORDER_POLL_MS,
} from "../../../src/features/video/hostRecorderTeardown";
import { FakeHostRecorderProcessControl } from "../../fakes/FakeHostRecorderProcessControl";
import { FakeTimer } from "../../fakes/FakeTimer";

const descriptor = {
  kind: "ios-host-recorder" as const,
  hostPid: 42,
  hostStartToken: "generation-a",
  udid: "simulator-id",
  capturePath: "/never-touch/raw.mov",
};

function harness() {
  const control = new FakeHostRecorderProcessControl();
  const timer = new FakeTimer();
  const stop = () => forceStopHostRecorder(descriptor, { control, timer });
  const finish = async (work: Promise<void>) => {
    // Manual stepping avoids the auto-advance pump's real event-loop work.
    for (
      let i = 0;
      i <=
      (HOST_RECORDER_INTERRUPT_TIMEOUT_MS + HOST_RECORDER_KILL_TIMEOUT_MS) / HOST_RECORDER_POLL_MS;
      i++
    ) {
      timer.advanceTime(HOST_RECORDER_POLL_MS);
      await Promise.resolve();
      await Promise.resolve();
      await Promise.resolve();
    }
    return work;
  };
  return { control, timer, stop, finish };
}

test("matching host recorder gets one SIGINT and finalizes without touching its path", async () => {
  const h = harness();
  h.control.onSignal = () => {
    h.control.running = false;
  };
  await h.finish(h.stop());
  expect(h.control.signals).toEqual([[42, "SIGINT"]]);
  expect(descriptor.capturePath).toBe("/never-touch/raw.mov");
});

test("teardown never reads the capture path for file deletion or truncation", async () => {
  const h = harness();
  h.control.onSignal = () => {
    h.control.running = false;
  };
  const guarded = {
    ...descriptor,
    get capturePath(): string {
      throw new Error("capture path must not be touched");
    },
  };
  await forceStopHostRecorder(guarded, h);
  expect(h.control.signals).toEqual([[42, "SIGINT"]]);
});

test("an already gone host recorder requires no token read or signal", async () => {
  const h = harness();
  h.control.running = false;
  await h.stop();
  expect(h.control.tokenReads).toBe(0);
  expect(h.control.signals).toEqual([]);
});

test("a recycled host pid is complete without signalling its replacement", async () => {
  const h = harness();
  h.control.token = "replacement";
  await h.stop();
  expect(h.control.signals).toEqual([]);
});

test("an unreadable running host identity is retained without signalling", async () => {
  const h = harness();
  h.control.token = undefined;
  await expect(h.stop()).rejects.toBeInstanceOf(ActionableError);
  expect(h.control.signals).toEqual([]);
});

test("escalation rechecks the token before SIGKILL after the interrupt bound", async () => {
  const h = harness();
  h.control.onSignal = (sig) => {
    if (sig === "SIGKILL") {
      h.control.running = false;
    }
  };
  await h.finish(h.stop());
  expect(h.control.signals).toEqual([
    [42, "SIGINT"],
    [42, "SIGKILL"],
  ]);
  expect(h.control.tokenReads).toBe(2);
  expect(h.timer.getSleepHistory().reduce((sum, ms) => sum + ms, 0)).toBe(
    HOST_RECORDER_INTERRUPT_TIMEOUT_MS,
  );
});

test.each(["replacement", undefined])(
  "token becomes %s before escalation: never SIGKILL",
  async (token) => {
    const h = harness();
    h.control.onSignal = () => {
      h.control.token = token;
    };
    const work = h.stop();
    if (token === undefined) {
      await expect(h.finish(work)).rejects.toBeInstanceOf(ActionableError);
    } else {
      await h.finish(work);
    }
    expect(h.control.signals).toEqual([[42, "SIGINT"]]);
  },
);

test("a host still alive after SIGKILL remains unconfirmed", async () => {
  const h = harness();
  await expect(h.finish(h.stop())).rejects.toBeInstanceOf(ActionableError);
  expect(h.control.signals).toEqual([
    [42, "SIGINT"],
    [42, "SIGKILL"],
  ]);
});

async function advanceRecorder(h: ReturnType<typeof harness>, ms: number) {
  for (let elapsed = 0; elapsed < ms; elapsed += HOST_RECORDER_POLL_MS) {
    h.timer.advanceTime(HOST_RECORDER_POLL_MS);
    await Promise.resolve();
    await Promise.resolve();
    await Promise.resolve();
  }
}

test("user stop allows a MOV to finalize at 25 seconds without SIGKILL", async () => {
  const h = harness();
  h.control.onSignal = (sig) => {
    if (sig === "SIGKILL") {
      h.control.running = false;
    }
  };
  h.timer.setTimeout(() => {
    h.control.running = false;
  }, 25_000);
  const work = forceStopHostRecorder(descriptor, h, { mode: "user" });
  await advanceRecorder(h, 30_000);
  await work;
  expect(h.control.signals).toEqual([[42, "SIGINT"]]);
});

test("user stop waits 30 seconds before token-checked SIGKILL", async () => {
  const h = harness();
  h.control.onSignal = (sig) => {
    if (sig === "SIGKILL") {
      h.control.running = false;
    }
  };
  const work = forceStopHostRecorder(descriptor, h, { mode: "user" });
  await advanceRecorder(h, 29_900);
  expect(h.control.signals).toEqual([[42, "SIGINT"]]);
  await advanceRecorder(h, 100);
  await work;
  expect(h.control.signals).toEqual([
    [42, "SIGINT"],
    [42, "SIGKILL"],
  ]);
  expect(h.control.tokenReads).toBe(2);
});

test("background stop becomes unconfirmed within the redrive budget and never kills", async () => {
  const h = harness();
  const work = forceStopHostRecorder(descriptor, h, { mode: "background" });
  let failure: unknown;
  const observed = work.then(
    () => {},
    (error: unknown) => {
      failure = error;
    },
  );
  await advanceRecorder(h, 5_000);
  expect(failure).toBeInstanceOf(ActionableError);
  expect(h.timer.getPendingSleepCount()).toBe(0);
  // Even well after the outer race expired, no detached escalation may run.
  await advanceRecorder(h, 40_000);
  await observed;
  expect(failure).toBeInstanceOf(ActionableError);
  expect(String(failure)).toContain("unconfirmed");
  expect(h.control.signals).toEqual([[42, "SIGINT"]]);
  expect(h.timer.getSleepHistory().reduce((sum, ms) => sum + ms, 0)).toBeLessThanOrEqual(5_000);
  expect(h.timer.getPendingSleepCount()).toBe(0);
});

test("background stop confirms an exit within its budget", async () => {
  const h = harness();
  h.timer.setTimeout(() => {
    h.control.running = false;
  }, 2_000);
  const work = forceStopHostRecorder(descriptor, h, { mode: "background" });
  await advanceRecorder(h, 5_000);
  await work;
  expect(h.control.signals).toEqual([[42, "SIGINT"]]);
});
