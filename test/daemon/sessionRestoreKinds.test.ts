import { afterEach, expect, spyOn, test } from "bun:test";
import { SessionManager } from "../../src/daemon/sessionManager";
import type {
  BoundedRetrySpec,
  PendingRestore,
  RestoreAttemptOutcome,
} from "../../src/daemon/deviceStateRestoreQueue";
import { logger } from "../../src/utils/logger";
import { FakeDbWriteBarrier } from "../fakes/FakeDbWriteBarrier";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

const managers: SessionManager[] = [];

function create() {
  const timer = new FakeTimer();
  const manager = new SessionManager(timer, new FakeDeviceSessionPersistence(), {
    barrier: () => new FakeDbWriteBarrier(),
  });
  managers.push(manager);
  return { timer, manager };
}

afterEach(() => {
  for (const manager of managers.splice(0)) {
    manager.stopCleanupTimer();
  }
});

const flush = async () => {
  for (let i = 0; i < 20; i++) {
    await Promise.resolve();
  }
};

function target<S extends object>(state: S): PendingRestore<S> {
  return {
    state,
    removed: false,
    controller: new AbortController(),
    clear: () => {},
    result: Promise.resolve({ pending: null }),
  };
}

function spec(overrides: Partial<BoundedRetrySpec<object>> = {}) {
  const abandoned: Array<{ error: unknown; when: string }> = [];
  const value: BoundedRetrySpec<object> = {
    attempts: 3,
    delayForAttempt: (attempt) => attempt * 10,
    isNonRetryable: () => false,
    logFirstFailure: () => {},
    logRetryFailure: () => {},
    abandon: (_id, _target, error, when) => abandoned.push({ error, when }),
    ...overrides,
  };
  return { value, abandoned };
}

const failed = (error: unknown): Promise<RestoreAttemptOutcome> =>
  Promise.resolve({ outcome: "failed", error });

function retryBounded(
  manager: SessionManager,
  s: BoundedRetrySpec<object>,
  t: PendingRestore<object>,
  restoration: Promise<RestoreAttemptOutcome>,
  restore: () => Promise<void>,
): Promise<void> {
  const owner = Reflect.get(manager, "stateRestore") as object;
  return Reflect.apply(Reflect.get(owner, "retryRestoreBounded"), owner, [
    s,
    "d1",
    t,
    { restoration, restore },
  ]);
}

test("bounded retry: a restored first attempt never retries or abandons", async () => {
  const { manager } = create();
  const { value, abandoned } = spec();
  let calls = 0;
  await retryBounded(
    manager,
    value,
    target({}),
    Promise.resolve({ outcome: "restored" }),
    async () => {
      calls++;
    },
  );
  expect(calls).toBe(0);
  expect(abandoned).toEqual([]);
});

test("bounded retry: exhausting the attempts paced by the backoff abandons with the last error", async () => {
  const { manager, timer } = create();
  const { value, abandoned } = spec();
  let calls = 0;
  const done = retryBounded(manager, value, target({}), failed("first"), async () => {
    calls++;
    throw new Error(`retry ${calls}`);
  });
  for (const delay of [10, 20, 30]) {
    await flush();
    timer.advanceTime(delay);
  }
  await done;
  expect(calls).toBe(3);
  expect(abandoned).toHaveLength(1);
  expect(abandoned[0]?.when).toBe("after 3 retries");
  expect((abandoned[0]?.error as Error).message).toBe("retry 3");
});

test("bounded retry: a retry that succeeds ends the loop without abandoning", async () => {
  const { manager, timer } = create();
  const { value, abandoned } = spec();
  let calls = 0;
  const done = retryBounded(manager, value, target({}), failed("first"), async () => {
    calls++;
    if (calls < 2) {
      throw new Error("again");
    }
  });
  for (const delay of [10, 20]) {
    await flush();
    timer.advanceTime(delay);
  }
  await done;
  expect(calls).toBe(2);
  expect(abandoned).toEqual([]);
});

test("bounded retry: a non-retryable first failure abandons without retrying", async () => {
  const { manager } = create();
  const { value, abandoned } = spec({ isNonRetryable: (error) => error === "managed" });
  let calls = 0;
  await retryBounded(manager, value, target({}), failed("managed"), async () => {
    calls++;
  });
  expect(calls).toBe(0);
  expect(abandoned).toEqual([{ error: "managed", when: "without retrying" }]);
});

test("bounded retry: a non-retryable retry failure abandons and stops the remaining retries", async () => {
  const { manager, timer } = create();
  const { value, abandoned } = spec({ isNonRetryable: (error) => error === "managed" });
  let calls = 0;
  const done = retryBounded(manager, value, target({}), failed("first"), async () => {
    calls++;
    throw "managed";
  });
  await flush();
  timer.advanceTime(10);
  await done;
  expect(calls).toBe(1);
  expect(abandoned).toEqual([{ error: "managed", when: "after 1 retries" }]);
});

test("bounded retry: a target removed during the backoff stops quietly", async () => {
  const { manager, timer } = create();
  const { value, abandoned } = spec();
  const t = target({});
  let calls = 0;
  const done = retryBounded(manager, value, t, failed("first"), async () => {
    calls++;
  });
  await flush();
  t.removed = true;
  timer.advanceTime(10);
  await done;
  expect(calls).toBe(0);
  expect(abandoned).toEqual([]);
});

// The abandoned-state memory differs by kind (#11794): rotation keeps the older, truer baseline;
// the screen reader remembers the latest.
test("rotation keeps the older abandoned baseline, the screen reader the newest", () => {
  const { manager } = create();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const older = { accelerometerRotation: 1, userRotation: 0 } as const;
    const newer = { accelerometerRotation: 0, userRotation: 1 } as const;
    const abandonRotation = Reflect.get(
      Reflect.get(manager, "stateRestore") as object,
      "abandonRotationRestore",
    ) as (...args: unknown[]) => void;
    abandonRotation.call(
      Reflect.get(manager, "stateRestore"),
      "d1",
      target({ ...older }),
      "x",
      "after 5 retries",
    );
    abandonRotation.call(
      Reflect.get(manager, "stateRestore"),
      "d1",
      target({ ...newer }),
      "x",
      "after 5 retries",
    );
    const rotations = Reflect.get(
      Reflect.get(manager, "stateRestore") as object,
      "abandonedRotations",
    ) as Map<string, object>;
    expect(rotations.get("d1")).toEqual(older);

    const stateRestore = Reflect.get(manager, "stateRestore") as object;
    const abandonScreenReader = Reflect.get(stateRestore, "abandonScreenReaderRestore") as (
      ...args: unknown[]
    ) => void;
    abandonScreenReader.call(
      stateRestore,
      "d1",
      target({ platform: "android", previousEnabled: false }),
    );
    abandonScreenReader.call(
      stateRestore,
      "d1",
      target({ platform: "android", previousEnabled: true }),
    );
    const screenReaders = Reflect.get(stateRestore, "abandonedScreenReaders") as Map<
      string,
      object
    >;
    expect(screenReaders.get("d1")).toEqual({ platform: "android", previousEnabled: true });
  } finally {
    warn.mockRestore();
  }
});

test("a removed target is not abandoned", () => {
  const { manager } = create();
  const warn = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const t = target({ accelerometerRotation: 1, userRotation: 0 });
    t.removed = true;
    Reflect.apply(
      Reflect.get(Reflect.get(manager, "stateRestore") as object, "abandonRotationRestore"),
      Reflect.get(manager, "stateRestore"),
      ["d1", t, "x", "when"],
    );
    expect(
      (
        Reflect.get(Reflect.get(manager, "stateRestore") as object, "abandonedRotations") as Map<
          string,
          object
        >
      ).size,
    ).toBe(0);
  } finally {
    warn.mockRestore();
  }
});
