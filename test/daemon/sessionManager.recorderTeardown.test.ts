import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { InMemoryDeviceHealthMarkers } from "../../src/daemon/deviceHealthMarkers";
import { SessionManager } from "../../src/daemon/sessionManager";
import { logger } from "../../src/utils/logger";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { drainUntilQuiescent } from "../helpers/fakeTimerStepping";

import { DeviceUnreachableError } from "../../src/models/DeviceUnreachableError";

const deviceId = "emulator-5554";
let timer: FakeTimer;
let manager: SessionManager;
let markers: InMemoryDeviceHealthMarkers;
let incarnation: number;
let recoverable: boolean;
let warn: ReturnType<typeof spyOn<typeof logger, "warn">>;
beforeEach(() => {
  timer = new FakeTimer();
  manager = new SessionManager(
    timer,
    new FakeDeviceSessionPersistence(),
    () => new FakeDbWriteBarrier(),
  );
  manager.stopCleanupTimer();
  markers = new InMemoryDeviceHealthMarkers(timer);
  incarnation = 1;
  recoverable = true;
  manager.setDeviceHealthMarkers(
    markers,
    () => incarnation,
    () => recoverable,
  );
  warn = spyOn(logger, "warn").mockImplementation(() => {});
});
afterEach(() => {
  manager.stopCleanupTimer();
  timer.reset();
  warn.mockRestore();
});
const marked = () => markers.get(deviceId, incarnation, "recording-teardown");
const mark = (retry: () => Promise<void>, timeout = 5000, key?: string) =>
  manager.markDeviceNeedsRecorderTeardown(deviceId, retry, timeout, key);
async function step(ms: number) {
  await timer.advanceTimeAsync(ms, () => drainUntilQuiescent(timer));
  await drainUntilQuiescent(timer);
}

test("independent retries settle independently; marker waits for every retry", async () => {
  let first = 0;
  let second = 0;
  mark(async () => {
    first++;
  });
  mark(async () => {
    if (++second === 1) {
      throw new Error("unconfirmed");
    }
  });
  await step(1000);
  expect(first).toBe(1);
  expect(second).toBe(1);
  expect(marked()).toBeDefined();
  await step(2000);
  expect(first).toBe(1);
  expect(second).toBe(2);
  expect(marked()).toBeUndefined();
});

test("same key replaces before dispatch and never calls the old closure", async () => {
  let old = 0;
  let replacement = 0;
  mark(
    async () => {
      old++;
    },
    5000,
    "give-ups",
  );
  mark(
    async () => {
      replacement++;
    },
    5000,
    "give-ups",
  );
  await step(1000);
  expect(old).toBe(0);
  expect(replacement).toBe(1);
  expect(marked()).toBeUndefined();
});

test("replacement during dispatch is not acknowledged by the old closure", async () => {
  const gate = Promise.withResolvers<void>();
  let old = 0;
  let replacement = 0;
  mark(
    async () => {
      old++;
      await gate.promise;
    },
    5000,
    "give-ups",
  );
  await step(1000);
  mark(
    async () => {
      replacement++;
    },
    5000,
    "give-ups",
  );
  gate.resolve();
  await step(0);
  expect(marked()).toBeDefined();
  await step(1000);
  expect(old).toBe(1);
  expect(replacement).toBe(1);
  expect(marked()).toBeUndefined();
});

test("later mark re-covers exhausted retries and cannot clear their marker", async () => {
  let old = 0;
  let newCalls = 0;
  let confirmed = false;
  mark(async () => {
    old++;
    if (!confirmed) {
      throw new Error("old unconfirmed");
    }
  });
  for (const delay of [1000, 2000, 4000]) {
    await step(delay);
  }
  expect(old).toBe(3);
  expect(manager.getDeviceHealthRecovery(deviceId, 1, "recording-teardown")).toEqual({
    recovering: true,
    retryAfterMs: 185_000,
  });
  mark(async () => {
    newCalls++;
  });
  await step(1000);
  expect(old).toBe(4);
  expect(newCalls).toBe(1);
  expect(marked()).toBeDefined();
  confirmed = true;
  await step(2000);
  expect(old).toBe(5);
  expect(newCalls).toBe(1);
  expect(marked()).toBeUndefined();
});

test.each([false, true])(
  "late retry during last attempt gets all three attempts (replacement=%p)",
  async (replacement) => {
    const gate = Promise.withResolvers<void>();
    let old = 0;
    let added = 0;
    mark(
      async () => {
        old++;
        if (old < 3) {
          throw new Error("old unconfirmed");
        }
        await gate.promise;
      },
      5000,
      "old",
    );
    for (const delay of [1000, 2000, 4000]) {
      await step(delay);
    }
    mark(
      async () => {
        if (++added < 3) {
          throw new Error("new unconfirmed");
        }
      },
      5000,
      replacement ? "old" : undefined,
    );
    gate.resolve();
    await step(0);
    expect(marked()).toBeDefined();
    for (const delay of [1000, 2000, 4000]) {
      await step(delay);
    }
    expect(old).toBe(3);
    expect(added).toBe(3);
    expect(marked()).toBeUndefined();
  },
);

test("skipped cleanup ticks preserve three dispatches for both entries", async () => {
  recoverable = false;
  const calls = [0, 0];
  for (const index of [0, 1]) {
    mark(async () => {
      if (++calls[index]! < 3) {
        throw new Error("unconfirmed");
      }
    });
  }
  await step(8000);
  expect(calls).toEqual([0, 0]);
  recoverable = true;
  for (const delay of [1000, 2000, 4000]) {
    await step(delay);
  }
  expect(calls).toEqual([3, 3]);
  expect(marked()).toBeUndefined();
});

test("larger late timeout invalidates the old bound and publishes a fresh sufficient budget", async () => {
  mark(async () => {
    throw new Error("unconfirmed");
  });
  await step(1000);
  mark(async () => {
    throw new Error("unconfirmed");
  }, 20000);
  expect(manager.getDeviceHealthRecovery(deviceId, 1, "recording-teardown")).toEqual({
    recovering: true,
  });
  await step(2000);
  // Attempt one ran at t=3000; attempts two and three have 2s/4s sleeps and 40s/60s caps.
  expect(
    manager.getDeviceHealthRecovery(deviceId, 1, "recording-teardown").retryAfterMs,
  ).toBeGreaterThanOrEqual(106000);
});

test("timed-out composite never overlaps and counts late per-entry successes", async () => {
  const gate = Promise.withResolvers<void>();
  const calls = [0, 0];
  mark(async () => {
    calls[0]++;
    await gate.promise;
  }, 100);
  mark(async () => {
    calls[1]++;
    throw new Error("unconfirmed");
  }, 100);
  await step(1000);
  await step(100);
  expect(manager.getDeviceHealthRecovery(deviceId, 1, "recording-teardown")).toEqual({
    recovering: true,
  });
  await step(10000);
  expect(calls).toEqual([1, 1]);
  gate.resolve();
  await step(0);
  await step(2000);
  expect(calls).toEqual([1, 2]);
  expect(marked()).toBeDefined();
});

test.each(["clear", "incarnation"])(
  "%s drops exhausted retries rather than resurrecting them",
  async (action) => {
    let old = 0;
    mark(async () => {
      old++;
      throw new Error("unconfirmed");
    });
    for (const delay of [1000, 2000, 4000]) {
      await step(delay);
    }
    if (action === "clear") {
      markers.clear(deviceId);
    } else {
      incarnation++;
    }
    mark(async () => {});
    await step(1000);
    expect(old).toBe(3);
    expect(marked()).toBeUndefined();
  },
);

test("app-cleanup composes a second mark while recovery runs", async () => {
  let first = 0;
  let second = 0;
  manager.markDeviceNeedsAppCleanup(
    deviceId,
    async () => {
      first++;
    },
    5000,
  );
  manager.markDeviceNeedsAppCleanup(
    deviceId,
    async () => {
      second++;
    },
    20000,
  );
  expect(manager.getDeviceHealthRecovery(deviceId, 1, "app-cleanup").retryAfterMs).toBeUndefined();
  await step(1000);
  expect(first).toBe(1);
  expect(second).toBe(1);
});

test("a new mark while the previous recovery clears is dispatched after its finalizer", async () => {
  const clear = markers.clear.bind(markers);
  let newCalls = 0;
  let added = false;
  const clearing = spyOn(markers, "clear").mockImplementation((id, epoch, reason) => {
    clear(id, epoch, reason);
    if (!added) {
      added = true;
      mark(async () => {
        newCalls++;
      });
    }
  });
  try {
    mark(async () => {});
    await step(1000);
    expect(marked()).toBeDefined();
    expect(newCalls).toBe(0);
    await step(1000);
    expect(newCalls).toBe(1);
    expect(marked()).toBeUndefined();
  } finally {
    clearing.mockRestore();
  }
});

test("five unreachable dispatches preserve attempt one and clear on the sixth", async () => {
  let calls = 0;
  mark(async () => {
    if (++calls <= 5) {
      throw new DeviceUnreachableError("no answer");
    }
  });
  for (let i = 0; i < 5; i++) {
    await step(1000);
    expect(calls).toBe(i + 1);
    expect(marked()).toBeDefined();
    expect(manager.getDeviceHealthRecovery(deviceId, 1, "recording-teardown")).toMatchObject({
      recovering: true,
      retryAfterMs: expect.any(Number),
    });
  }
  await step(1000);
  expect(calls).toBe(6);
  expect(marked()).toBeUndefined();
});

test("timed-out composite settling unreachable re-arms the same attempt", async () => {
  const gate = Promise.withResolvers<void>();
  let calls = 0;
  mark(async () => {
    if (++calls === 1) {
      await gate.promise;
      throw new DeviceUnreachableError("no answer");
    }
  }, 100);
  await step(1000);
  await step(100);
  gate.resolve();
  await step(0);
  await step(1000);
  expect(calls).toBe(2);
  expect(marked()).toBeUndefined();
});

test("a reached failure alongside an unreachable entry consumes the attempt", async () => {
  const calls = [0, 0];
  mark(async () => {
    calls[0]++;
    throw new DeviceUnreachableError("no answer");
  });
  mark(async () => {
    calls[1]++;
    throw new Error("kill refused");
  });
  for (const delay of [1000, 2000, 4000]) {
    await step(delay);
  }
  expect(calls).toEqual([3, 3]);
  await step(1000);
  expect(calls).toEqual([3, 3]);
});

test("exhaustion publishes the hard-limit re-check and clears when the pid is gone", async () => {
  let calls = 0;
  let gone = false;
  mark(async () => {
    calls++;
    if (!gone) {
      throw new Error("recorder survives kill");
    }
  });
  for (const delay of [1000, 2000, 4000]) {
    await step(delay);
  }
  expect(calls).toBe(3);
  expect(manager.getDeviceHealthRecovery(deviceId, 1, "recording-teardown")).toEqual({
    recovering: true,
    retryAfterMs: 185_000,
  });
  recoverable = false;
  expect(manager.getDeviceHealthRecovery(deviceId, 1, "recording-teardown")).toEqual({
    recovering: true,
    retryAfterMs: 185_000,
  });
  recoverable = true;
  gone = true;
  await step(185_000);
  await step(1000);
  expect(calls).toBe(4);
  expect(marked()).toBeUndefined();
});

test("re-check exhausts once, leaving the marker held with no timers", async () => {
  let calls = 0;
  mark(async () => {
    calls++;
    throw new Error("still unconfirmed");
  });
  for (const delay of [1000, 2000, 4000, 185_000, 1000, 2000, 4000]) {
    await step(delay);
  }
  expect(calls).toBe(6);
  expect(manager.getDeviceHealthRecovery(deviceId, 1, "recording-teardown")).toEqual({
    recovering: false,
  });
  expect(timer.getPendingTimeoutCount()).toBe(0);
  expect(timer.getPendingSleepCount()).toBe(0);
});

test.each(["clear", "incarnation", "shutdown"])(
  "re-check ignores %s before firing",
  async (action) => {
    let calls = 0;
    mark(async () => {
      calls++;
      throw new Error("unconfirmed");
    });
    for (const delay of [1000, 2000, 4000]) {
      await step(delay);
    }
    if (action === "clear") {
      markers.clear(deviceId);
    } else if (action === "incarnation") {
      incarnation++;
    } else {
      manager.stopAcceptingSessionCreations();
    }
    await step(200_000);
    expect(calls).toBe(3);
    expect(timer.getPendingTimeoutCount()).toBe(0);
  },
);

test("app cleanup exhausts with no hard-limit re-check", async () => {
  let calls = 0;
  manager.markDeviceNeedsAppCleanup(
    deviceId,
    async () => {
      calls++;
      throw new Error("cleanup refused");
    },
    5000,
  );
  for (const delay of [1000, 2000, 4000, 200_000]) {
    await step(delay);
  }
  expect(calls).toBe(3);
  expect(manager.getDeviceHealthRecovery(deviceId, 1, "app-cleanup")).toEqual({
    recovering: false,
  });
  expect(timer.getPendingTimeoutCount()).toBe(0);
});

test("recorder disposer clears only its registered entry synchronously", async () => {
  let calls = 0;
  const dispose = mark(
    async () => {
      calls++;
    },
    5000,
    "startup",
  );
  dispose();
  expect(marked()).toBeUndefined();
  await step(1000);
  expect(calls).toBe(0);
});

test("old disposer cannot remove a replacement or an independent keyed retry", async () => {
  let replacement = 0;
  const dispose = mark(async () => {}, 5000, "startup");
  mark(
    async () => {
      replacement++;
    },
    5000,
    "startup",
  );
  const independent = mark(
    async () => {
      throw new Error("independent");
    },
    5000,
    "release",
  );
  dispose();
  expect(marked()).toBeDefined();
  await step(1000);
  expect(replacement).toBe(1);
  expect(marked()).toBeDefined();
  independent();
  expect(marked()).toBeUndefined();
});

test("shutdown ends idle unreachable re-arms with retries and marker retained", async () => {
  let calls = 0;
  mark(async () => {
    calls++;
    throw new DeviceUnreachableError("frozen device");
  });
  await step(3000);
  expect(calls).toBe(3);
  manager.stopAcceptingSessionCreations();
  await step(30_000);
  expect(calls).toBe(4);
  expect(timer.getPendingSleepCount()).toBe(0);
  expect(timer.getPendingTimeoutCount()).toBe(0);
  expect(marked()).toBeDefined();
  expect(manager.getDeviceHealthRecovery(deviceId, 1, "recording-teardown").recovering).toBe(false);
  // The shutdown fence must keep the owed retry available to a later explicit mark.
  mark(async () => {});
  await step(1000);
  expect(calls).toBe(5);
  expect(marked()).toBeDefined();
  expect(timer.getPendingSleepCount()).toBe(0);
});
