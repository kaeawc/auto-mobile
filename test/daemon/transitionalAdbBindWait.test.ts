import { describe, expect, spyOn, test } from "bun:test";
import { TransitionalAdbBindWait } from "../../src/daemon/transitionalAdbBindWait";
import { DeviceTransportOfflineError } from "../../src/daemon/deviceAcquisitionRefusals";
import { fixedBackoff } from "../../src/utils/Backoff";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { drainUntil, drainUntilQuiescent } from "../helpers/fakeTimerStepping";

const id = "emulator-5560";
const offline = () => new Map([[id, "offline"]]);

describe("transitional adb bind wait", () => {
  test("a live launch holds initial absence and refuses truthfully at the bounded deadline", async () => {
    const timer = new FakeTimer();
    const wait = new TransitionalAdbBindWait(id, {
      timer,
      getSignal: () => undefined,
      probeTimeoutMs: 10000,
      backoff: fixedBackoff(5000),
      probe: async () => new Map(),
      isLaunchProcessAlive: () => true,
    });
    const pending = wait.waitIfTransitional();
    await drainUntilQuiescent(timer);
    expect(timer.getPendingTimeouts()).toEqual([5000]);
    timer.advanceTime(5000);
    expect(await pending).toBe(true);
    await expect(wait.waitIfTransitional()).rejects.toMatchObject({
      code: "device_offline",
      retryable: true,
      retryAfterMs: 1000,
      message: `The emulator process this request started for device '${id}' is still running but adb does not list its transport yet (code device_offline); it was not bound. Retry in about 1000ms.`,
    });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each([undefined, "device"])(
    "a boot-resolved adopted runtime waits for a fresh listing with probe %s",
    async (state) => {
      const timer = new FakeTimer();
      const wait = new TransitionalAdbBindWait(id, {
        timer,
        getSignal: () => undefined,
        probeTimeoutMs: 10000,
        backoff: fixedBackoff(5000),
        probe: async () => (state === undefined ? new Map() : new Map([[id, state]])),
        hasResolvedRuntime: true,
      });
      const pending = wait.waitIfTransitional();
      await drainUntilQuiescent(timer);
      expect(timer.getPendingTimeouts()).toEqual([5000]);
      timer.advanceTime(5000);
      expect(await pending).toBe(true);
      await expect(wait.waitIfTransitional()).rejects.toMatchObject({
        code: "device_offline",
        retryable: true,
        retryAfterMs: 1000,
        state: undefined,
        name: "DeviceTransportOfflineError",
        message: `adb did not list the previously resolved emulator '${id}' steadily while binding (its transport was absent or flapping) (code device_offline); it was not bound. Retry in about 1000ms.`,
      });
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test.each([undefined, () => false])(
    "absent transport without a live launch stays absent (%s)",
    async (isLaunchProcessAlive) => {
      const timer = new FakeTimer();
      const wait = new TransitionalAdbBindWait(id, {
        timer,
        getSignal: () => undefined,
        probeTimeoutMs: 10000,
        probe: async () => new Map(),
        isLaunchProcessAlive,
      });
      expect(await wait.waitIfTransitional()).toBe(false);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("stale listing with a live launch waits once for a present transport within budget", async () => {
    const timer = new FakeTimer();
    const wait = new TransitionalAdbBindWait(id, {
      timer,
      getSignal: () => undefined,
      probeTimeoutMs: 10000,
      backoff: fixedBackoff(5000),
      probe: async () => new Map([[id, "device"]]),
      isLaunchProcessAlive: () => true,
    });
    const pending = wait.waitIfTransitional();
    await drainUntilQuiescent(timer);
    expect(timer.getPendingTimeouts()).toEqual([5000]);
    timer.advanceTime(5000);
    expect(await pending).toBe(true);
    expect(await wait.waitIfTransitional()).toBe(false);
    expect(timer.now()).toBe(5000);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("stale listing wait with a live launch is abortable", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const wait = new TransitionalAdbBindWait(id, {
      timer,
      getSignal: () => controller.signal,
      probeTimeoutMs: 10000,
      probe: async () => new Map([[id, "device"]]),
      isLaunchProcessAlive: () => true,
    });
    const pending = wait.waitIfTransitional();
    await drainUntilQuiescent(timer);
    expect(timer.getPendingTimeouts()).toEqual([100]);
    const reason = new DOMException("cancel stale snapshot wait", "AbortError");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("uses exponential delays in order and stops at the total budget", async () => {
    const timer = new FakeTimer();
    const timeouts: number[] = [];
    const wait = new TransitionalAdbBindWait(id, {
      timer,
      getSignal: () => undefined,
      probeTimeoutMs: 10000,
      probe: async (_ids, options) => {
        timeouts.push(options!.timeoutMs!);
        return offline();
      },
    });
    for (const delay of [100, 200, 400, 800, 1000, 1000, 1000, 500]) {
      const pending = wait.waitIfTransitional();
      await drainUntil(() => timer.getPendingTimeouts().includes(delay), {
        description: "backoff delay",
      });
      await drainUntilQuiescent(timer);
      // The probe has settled; only the backoff should remain armed.
      expect(timer.getPendingTimeouts()).toEqual([delay]);
      timer.advanceTime(delay);
      expect(await pending).toBe(true);
    }
    await expect(wait.waitIfTransitional()).rejects.toBeInstanceOf(DeviceTransportOfflineError);
    expect(timer.now()).toBe(5000);
    expect(timeouts).toEqual([5000, 4900, 4700, 4300, 3500, 2500, 1500, 500, 100]);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("caps the probe and delay by remaining time including time spent probing", async () => {
    const timer = new FakeTimer();
    const timeouts: number[] = [];
    const wait = new TransitionalAdbBindWait(id, {
      timer,
      getSignal: () => undefined,
      probeTimeoutMs: 10000,
      backoff: fixedBackoff(4300),
      probe: async (_ids, options) => {
        timeouts.push(options!.timeoutMs!);
        if (timeouts.length === 2) {
          timer.advanceTime(600);
        }
        return offline();
      },
    });
    const first = wait.waitIfTransitional();
    await drainUntil(() => timer.getPendingTimeouts().includes(4300), {
      description: "first delay",
    });
    timer.advanceTime(4300);
    await first;
    const second = wait.waitIfTransitional();
    await drainUntil(() => timer.getPendingTimeouts().includes(100), {
      description: "remaining delay",
    });
    expect(timeouts).toEqual([5000, 700]);
    timer.advanceTime(100);
    await second;
    await expect(wait.waitIfTransitional()).rejects.toMatchObject({
      code: "device_offline",
      state: "offline",
    });
    expect(timer.now()).toBe(5000);
  });

  test("uses the smaller configured probe timeout", async () => {
    const timer = new FakeTimer();
    const probe = spyOn({ run: async () => new Map<string, string>() }, "run");
    const wait = new TransitionalAdbBindWait(id, {
      timer,
      probe,
      probeTimeoutMs: 50,
      getSignal: () => undefined,
    });
    expect(await wait.waitIfTransitional()).toBe(false);
    expect(probe).toHaveBeenCalledWith([id], { signal: undefined, timeoutMs: 50 });
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test.each([undefined, "recovery", "device"])(
    "a final fresh probe returning %s preserves absence handling",
    async (state) => {
      const timer = new FakeTimer();
      const timeouts: number[] = [];
      let states = offline();
      const wait = new TransitionalAdbBindWait(id, {
        timer,
        getSignal: () => undefined,
        probeTimeoutMs: 50,
        backoff: fixedBackoff(5000),
        probe: async (_ids, options) => {
          timeouts.push(options!.timeoutMs!);
          return states;
        },
      });
      const pending = wait.waitIfTransitional();
      await drainUntil(() => timer.getPendingTimeouts().includes(5000), {
        description: "final delay",
      });
      states = state === undefined ? new Map() : new Map([[id, state]]);
      timer.advanceTime(5000);
      await pending;
      expect(await wait.waitIfTransitional()).toBe(false);
      expect(timeouts).toEqual([50, 50]);
      expect(timer.now()).toBe(5000);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("a slow first probe consumes the total wait budget", async () => {
    const timer = new FakeTimer();
    const wait = new TransitionalAdbBindWait(id, {
      timer,
      getSignal: () => undefined,
      probeTimeoutMs: 10000,
      backoff: fixedBackoff(5000),
      probe: async () => {
        timer.advanceTime(600);
        return offline();
      },
    });
    const pending = wait.waitIfTransitional();
    await drainUntil(() => timer.getPendingTimeouts().includes(4400), {
      description: "budget after slow first probe",
    });
    expect(timer.now()).toBe(600);
    expect(timer.getPendingTimeouts()).toEqual([4400]);
    timer.advanceTime(4400);
    expect(await pending).toBe(true);
    expect(timer.now()).toBe(5000);
  });

  test.each([undefined, "recovery", "device"])(
    "non-transitional state %s does not wait",
    async (state) => {
      const timer = new FakeTimer();
      const wait = new TransitionalAdbBindWait(id, {
        timer,
        probeTimeoutMs: 10000,
        getSignal: () => undefined,
        probe: async () => (state === undefined ? new Map() : new Map([[id, state]])),
      });
      expect(await wait.waitIfTransitional()).toBe(false);
      expect(timer.getPendingTimeoutCount()).toBe(0);
    },
  );

  test("an absent optional probe preserves absence handling", async () => {
    const timer = new FakeTimer();
    const wait = new TransitionalAdbBindWait(id, {
      timer,
      probeTimeoutMs: 10000,
      getSignal: () => undefined,
    });
    expect(await wait.waitIfTransitional()).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("an unauthorized transport waits and cancellation clears its timer", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const wait = new TransitionalAdbBindWait(id, {
      timer,
      probeTimeoutMs: 10000,
      getSignal: () => controller.signal,
      probe: async () => new Map([[id, "unauthorized"]]),
    });
    const pending = wait.waitIfTransitional();
    await drainUntil(() => timer.getPendingTimeouts().includes(100), {
      description: "unauthorized wait",
    });
    const reason = new DOMException("caller aborted", "AbortError");
    controller.abort(reason);
    await expect(pending).rejects.toBe(reason);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });

  test("an abort during the probe propagates instead of returning absence", async () => {
    const timer = new FakeTimer();
    const controller = new AbortController();
    const reason = new DOMException("abort probe", "AbortError");
    const warn = spyOn(logger, "warn");
    const wait = new TransitionalAdbBindWait(id, {
      timer,
      probeTimeoutMs: 10000,
      getSignal: () => controller.signal,
      probe: async () => {
        controller.abort(reason);
        throw reason;
      },
    });
    try {
      await expect(wait.waitIfTransitional()).rejects.toBe(reason);
      expect(warn).not.toHaveBeenCalled();
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });

  test("a hung probe is bounded, logged, and preserves absence handling", async () => {
    const timer = new FakeTimer();
    const warn = spyOn(logger, "warn");
    const wait = new TransitionalAdbBindWait(id, {
      timer,
      probeTimeoutMs: 50,
      getSignal: () => undefined,
      probe: () => new Promise(() => {}),
    });
    try {
      const pending = wait.waitIfTransitional();
      timer.advanceTime(50);
      expect(await pending).toBe(false);
      expect(warn).toHaveBeenCalledWith(expect.any(String), expect.any(Error));
      expect(timer.getPendingTimeoutCount()).toBe(0);
    } finally {
      warn.mockRestore();
    }
  });
});

for (const hold of [true, false]) {
  test(`absence after an observed offline row holds only when opted in: ${hold}`, async () => {
    const timer = new FakeTimer();
    let states = offline();
    const wait = new TransitionalAdbBindWait(id, {
      timer,
      getSignal: () => undefined,
      probeTimeoutMs: 10000,
      backoff: fixedBackoff(2500),
      holdAbsenceAfterTransitional: hold,
      probe: async () => states,
    });
    const first = wait.waitIfTransitional();
    await drainUntilQuiescent(timer);
    timer.advanceTime(2500);
    expect(await first).toBe(true);
    states = new Map();
    const absent = wait.waitIfTransitional();
    await drainUntilQuiescent(timer);
    expect(timer.getPendingTimeouts()).toEqual(hold ? [2500] : []);
    if (hold) {
      timer.advanceTime(2500);
    }
    expect(await absent).toBe(hold);
    expect(await wait.waitIfTransitional()).toBe(false);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  });
}

test("opted-in absence never seen transitional returns immediately", async () => {
  const timer = new FakeTimer();
  const wait = new TransitionalAdbBindWait(id, {
    timer,
    getSignal: () => undefined,
    probeTimeoutMs: 10000,
    holdAbsenceAfterTransitional: true,
    probe: async () => new Map(),
  });
  expect(await wait.waitIfTransitional()).toBe(false);
  expect(timer.getPendingTimeoutCount()).toBe(0);
});
