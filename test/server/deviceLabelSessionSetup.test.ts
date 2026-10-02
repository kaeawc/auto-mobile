import { describe, expect, test } from "bun:test";
import {
  MAX_CONCURRENT_LABEL_SESSION_SETUPS,
  setUpLabelSessionsConcurrently,
} from "../../src/server/deviceLabelMapping";

/** In-memory readiness work: gates control settlement without clocks or device I/O. */
class FakeLabelSetup {
  readonly starts: string[] = [];
  readonly signals = new Map<string, AbortSignal | undefined>();
  readonly gates = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  readonly started = new Map<string, ReturnType<typeof Promise.withResolvers<void>>>();
  active = 0;
  peak = 0;
  settled = 0;

  constructor(readonly sessionUuids: readonly string[]) {
    for (const sessionUuid of sessionUuids) {
      this.gates.set(sessionUuid, Promise.withResolvers<void>());
      this.started.set(sessionUuid, Promise.withResolvers<void>());
    }
  }

  setup = async (sessionUuid: string, signal: AbortSignal | undefined): Promise<void> => {
    this.starts.push(sessionUuid);
    this.signals.set(sessionUuid, signal);
    this.active += 1;
    this.peak = Math.max(this.peak, this.active);
    this.started.get(sessionUuid)!.resolve();
    try {
      await this.gates.get(sessionUuid)!.promise;
    } finally {
      this.active -= 1;
      this.settled += 1;
    }
  };

  run(maxConcurrency?: number, signal?: AbortSignal): Promise<void> {
    return setUpLabelSessionsConcurrently({
      sessionUuids: this.sessionUuids,
      setup: this.setup,
      maxConcurrency,
      signal,
    });
  }
}

async function flushMicrotasks(): Promise<void> {
  for (let turn = 0; turn < 8; turn += 1) {
    await Promise.resolve();
  }
}

describe("bounded label-session readiness setup", () => {
  test("starts three labels before any settles and drains every started setup", async () => {
    const fake = new FakeLabelSetup(["A", "B", "C"]);
    let resolved = false;
    const work = fake.run().then(() => {
      resolved = true;
    });
    expect(fake.starts).toEqual(["A", "B", "C"]);
    expect(fake.peak).toBe(3);
    fake.gates.get("B")!.resolve();
    fake.gates.get("C")!.resolve();
    await flushMicrotasks();
    expect(resolved).toBe(false);
    fake.gates.get("A")!.resolve();
    await work;
    expect(resolved).toBe(true);
    expect(fake.settled).toBe(3);
  });

  test("caps five labels at two and starts the next input only when a slot frees", async () => {
    const fake = new FakeLabelSetup(["A", "B", "C", "D", "E"]);
    const work = fake.run(2);
    expect(fake.starts).toEqual(["A", "B"]);
    fake.gates.get("B")!.resolve();
    await fake.started.get("C")!.promise;
    expect(fake.starts).toEqual(["A", "B", "C"]);
    expect(fake.active).toBe(2);
    fake.gates.get("A")!.resolve();
    await fake.started.get("D")!.promise;
    expect(fake.starts).toEqual(["A", "B", "C", "D"]);
    fake.gates.get("D")!.resolve();
    await fake.started.get("E")!.promise;
    expect(fake.starts).toEqual(fake.sessionUuids);
    fake.gates.get("C")!.resolve();
    fake.gates.get("E")!.resolve();
    await work;
    expect(fake.peak).toBe(2);
    expect(fake.settled).toBe(5);
  });

  test("uses the exported default bound when concurrency is omitted", async () => {
    const fake = new FakeLabelSetup(["A", "B", "C", "D", "E", "F"]);
    const work = fake.run();
    expect(MAX_CONCURRENT_LABEL_SESSION_SETUPS).toBe(4);
    expect(fake.starts).toEqual(fake.sessionUuids.slice(0, MAX_CONCURRENT_LABEL_SESSION_SETUPS));
    for (const sessionUuid of fake.sessionUuids) {
      await fake.started.get(sessionUuid)!.promise;
      fake.gates.get(sessionUuid)!.resolve();
    }
    await work;
    expect(fake.peak).toBe(MAX_CONCURRENT_LABEL_SESSION_SETUPS);
  });

  test.each([
    ["C", "A", "B"],
    ["B", "C", "A"],
    ["A", "B", "C"],
  ])(
    "completion permutation %s/%s/%s preserves input start order and void result",
    async (...order) => {
      const fake = new FakeLabelSetup(["A", "B", "C"]);
      const work = fake.run();
      expect(fake.starts).toEqual(fake.sessionUuids);
      for (const sessionUuid of order) {
        fake.gates.get(sessionUuid)!.resolve();
        await flushMicrotasks();
      }
      expect(await work).toBeUndefined();
      expect(fake.settled).toBe(3);
    },
  );

  test.each([true, false])(
    "lowest input failure wins when later failure arrives first: %s",
    async (laterFirst) => {
      const fake = new FakeLabelSetup(["A", "B", "C"]);
      const firstError = new Error("A failed");
      const laterError = new Error("C failed");
      let finished = false;
      const result = fake.run().then(
        () => {
          finished = true;
        },
        (error: unknown) => {
          finished = true;
          return error;
        },
      );
      expect(fake.starts).toEqual(fake.sessionUuids);
      const order = laterFirst ? ["C", "A"] : ["A", "C"];
      fake.gates.get(order[0])!.reject(laterFirst ? laterError : firstError);
      await flushMicrotasks();
      expect(finished).toBe(false);
      fake.gates.get(order[1])!.reject(laterFirst ? firstError : laterError);
      fake.gates.get("B")!.resolve();
      expect(await result).toBe(firstError);
      expect(fake.settled).toBe(3);
    },
  );

  test.each(["private reason", "AbortError", "ABORT_ERR"])(
    "failure stops unstarted labels and ignores sibling cancellation via %s",
    async (abortShape) => {
      const fake = new FakeLabelSetup(["A", "B", "C", "D", "E"]);
      const failure = new Error("B failed");
      let finished = false;
      const result = fake.run(2).then(
        () => {
          finished = true;
        },
        (error: unknown) => {
          finished = true;
          return error;
        },
      );
      expect(fake.starts).toEqual(["A", "B"]);
      fake.gates.get("B")!.reject(failure);
      await flushMicrotasks();
      expect(fake.signals.get("A")!.aborted).toBe(true);
      expect(fake.signals.get("B")!.aborted).toBe(true);
      expect(finished).toBe(false);
      const abortError =
        abortShape === "private reason"
          ? fake.signals.get("A")!.reason
          : abortShape === "AbortError"
            ? new DOMException("cancelled", "AbortError")
            : { code: "ABORT_ERR" };
      fake.gates.get("A")!.reject(abortError);
      expect(await result).toBe(failure);
      expect(fake.starts).toEqual(["A", "B"]);
      expect(fake.settled).toBe(2);
    },
  );

  test("caller abort reaches all in-flight setups and drains them before rejecting", async () => {
    const fake = new FakeLabelSetup(["A", "B", "C", "D"]);
    const controller = new AbortController();
    const reason = new Error("caller cancelled");
    let finished = false;
    const result = fake.run(2, controller.signal).then(
      () => {
        finished = true;
      },
      (error: unknown) => {
        finished = true;
        return error;
      },
    );
    expect(fake.starts).toEqual(["A", "B"]);
    controller.abort(reason);
    expect(fake.signals.get("A")!.aborted).toBe(true);
    expect(fake.signals.get("B")!.reason).toBe(reason);
    fake.gates.get("B")!.resolve();
    await flushMicrotasks();
    expect(fake.starts).toEqual(["A", "B"]);
    expect(finished).toBe(false);
    fake.gates.get("A")!.resolve();
    expect(await result).toBe(reason);
    expect(fake.settled).toBe(2);
  });

  test("caller abort retains the lowest-index rejection instead of replacing it with its reason", async () => {
    const fake = new FakeLabelSetup(["A", "B", "C"]);
    const controller = new AbortController();
    const failure = new DOMException("A cancelled", "AbortError");
    const result = fake.run(2, controller.signal).then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(fake.starts).toEqual(["A", "B"]);
    controller.abort(new Error("caller cancelled"));
    fake.gates.get("B")!.reject(new Error("B failed"));
    await flushMicrotasks();
    fake.gates.get("A")!.reject(failure);
    expect(await result).toBe(failure);
    expect(fake.starts).toEqual(["A", "B"]);
  });

  test.each([["A"], ["A", "B"]])(
    "pre-aborted callers start no setup for %j",
    async (...sessionUuids) => {
      const fake = new FakeLabelSetup(sessionUuids);
      const controller = new AbortController();
      const reason = new Error("already cancelled");
      controller.abort(reason);
      const result = fake.run(2, controller.signal).then(
        () => undefined,
        (error: unknown) => error,
      );
      expect(fake.starts).toEqual([]);
      expect(await result).toBe(reason);
    },
  );

  test.each([true, false])(
    "one derived session keeps original signal identity (provided: %s)",
    async (provided) => {
      const fake = new FakeLabelSetup(["A"]);
      const signal = provided ? new AbortController().signal : undefined;
      const work = fake.run(undefined, signal);
      expect(fake.starts).toEqual(["A"]);
      expect(fake.signals.get("A")).toBe(signal);
      fake.gates.get("A")!.resolve();
      await work;
      expect(fake.settled).toBe(1);
    },
  );

  test("zero derived sessions invoke no setup", async () => {
    const fake = new FakeLabelSetup([]);
    await fake.run();
    expect(fake.starts).toEqual([]);
  });

  test("an initial abort-shaped failure is a genuine cause", async () => {
    const fake = new FakeLabelSetup(["A", "B"]);
    const failure = new DOMException("device setup aborted", "AbortError");
    const result = fake.run().then(
      () => undefined,
      (error: unknown) => error,
    );
    expect(fake.starts).toEqual(["A", "B"]);
    fake.gates.get("B")!.reject(failure);
    await flushMicrotasks();
    fake.gates.get("A")!.reject(fake.signals.get("A")!.reason);
    expect(await result).toBe(failure);
    expect(fake.settled).toBe(2);
  });

  test("undefined rejection remains a failure and is drained", async () => {
    const fake = new FakeLabelSetup(["A", "B"]);
    const result = fake.run().then(
      () => ({ rejected: false }),
      (error: unknown) => ({ rejected: true, error }),
    );
    expect(fake.starts).toEqual(["A", "B"]);
    fake.gates.get("A")!.reject(undefined);
    await flushMicrotasks();
    fake.gates.get("B")!.resolve();
    expect(await result).toEqual({ rejected: true, error: undefined });
    expect(fake.settled).toBe(2);
  });

  test.each([0, -1, 1.5, Infinity, NaN])(
    "rejects invalid multi-label concurrency %s without starting",
    async (maxConcurrency) => {
      const fake = new FakeLabelSetup(["A", "B"]);
      const work = fake.run(maxConcurrency);
      expect(fake.starts).toEqual([]);
      await expect(work).rejects.toThrow(RangeError);
    },
  );
});
