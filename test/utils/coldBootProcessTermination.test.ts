import { describe, expect, it } from "bun:test";
import {
  awaitTerminationWithinRequest,
  SURVIVING_PROCESS_RECHECK_INTERVAL_MS,
  watchSurvivingProcess,
  type OwnedTermination,
} from "../../src/devices/coldBootProcessTermination";
import { FakeTimer } from "../fakes/FakeTimer";

// #9920: the liveness watch on an emulator that survived SIGKILL, and the
// request-bounded wait on a termination.

const PID = 4242;

async function settle(): Promise<void> {
  for (let attempt = 0; attempt < 3; attempt++) {
    await new Promise<void>((resolve) => setImmediate(resolve));
  }
}

/** A FakeTimer that records whether each timer it handed out was unref'd, and which were cleared. */
class RecordingTimer extends FakeTimer {
  readonly unrefCalls: NodeJS.Timeout[] = [];
  readonly cleared: NodeJS.Timeout[] = [];

  override setTimeout(callback: () => void, ms: number): NodeJS.Timeout {
    const handle = super.setTimeout(callback, ms);
    const wrapped = Object.assign(Object(handle), {
      unref: () => {
        this.unrefCalls.push(handle);
        return wrapped;
      },
    }) as NodeJS.Timeout;
    this.handles.set(wrapped, handle);
    return wrapped;
  }

  override clearTimeout(handle: NodeJS.Timeout): void {
    const original = this.handles.get(handle) ?? handle;
    this.cleared.push(original);
    super.clearTimeout(original);
  }

  private readonly handles = new Map<NodeJS.Timeout, NodeJS.Timeout>();
}

function watch(isRunning: (pid: number) => boolean, handle: { pid?: number } = { pid: PID }) {
  const timer = new RecordingTimer();
  const exit = Promise.withResolvers<void>();
  let gone = false;
  void watchSurvivingProcess(handle, exit.promise, "Pixel_9", timer, isRunning).then(() => {
    gone = true;
  });
  return { timer, exit, gone: () => gone };
}

describe("watchSurvivingProcess (#9920)", () => {
  it("settles when the pid is gone without any exit event", async () => {
    let running = true;
    const probed: number[] = [];
    const w = watch((pid) => {
      probed.push(pid);
      return running;
    });

    w.timer.advanceTime(SURVIVING_PROCESS_RECHECK_INTERVAL_MS);
    await settle();
    expect(w.gone()).toBe(false);
    expect(probed).toEqual([PID]);

    running = false;
    w.timer.advanceTime(SURVIVING_PROCESS_RECHECK_INTERVAL_MS);
    await settle();
    expect(w.gone()).toBe(true);
    expect(w.timer.getPendingTimeoutCount()).toBe(0);
  });

  it("never probes before the first interval elapses", async () => {
    const probed: number[] = [];
    const w = watch((pid) => {
      probed.push(pid);
      return true;
    });

    w.timer.advanceTime(SURVIVING_PROCESS_RECHECK_INTERVAL_MS - 1);
    await settle();

    expect(probed).toEqual([]);
    expect(w.gone()).toBe(false);
  });

  it("clears its pending re-check when the exit event settles it first", async () => {
    const w = watch(() => true);
    expect(w.timer.getPendingTimeoutCount()).toBe(1);

    w.exit.resolve();
    await settle();

    expect(w.gone()).toBe(true);
    expect(w.timer.getPendingTimeoutCount()).toBe(0);
    expect(w.timer.cleared).toHaveLength(1);
  });

  it("unrefs every re-check timer so it can never hold the daemon open", async () => {
    const w = watch(() => true);
    w.timer.advanceTime(SURVIVING_PROCESS_RECHECK_INTERVAL_MS * 2);
    await settle();

    // One timer per interval, each unref'd as it was scheduled.
    expect(w.timer.unrefCalls.length).toBeGreaterThanOrEqual(3);
    expect(w.timer.getPendingTimeoutCount()).toBe(1);
  });

  it("falls back to the exit event alone when the pid is unknown", async () => {
    const w = watch(() => {
      throw new Error("must not probe without a pid");
    }, {});
    expect(w.timer.getPendingTimeoutCount()).toBe(0);

    w.exit.resolve();
    await settle();
    expect(w.gone()).toBe(true);
  });
});

describe("awaitTerminationWithinRequest (#9920)", () => {
  const confirmed: OwnedTermination = { state: "confirmed" };

  function request(overrides: { deadlineMs?: number; signal?: AbortSignal } = {}) {
    const timer = new FakeTimer();
    return { timer, bounds: { timer, deadlineMs: 60_000, ...overrides } };
  }

  it("reports the termination's outcome when it settles within the request", async () => {
    const { bounds } = request();
    const survived: OwnedTermination = { state: "survived", gone: new Promise(() => {}) };

    expect(await awaitTerminationWithinRequest(Promise.resolve(confirmed), bounds)).toBe(
      "confirmed",
    );
    expect(await awaitTerminationWithinRequest(Promise.resolve(survived), bounds)).toBe("survived");
  });

  it("stops waiting when the request deadline passes first", async () => {
    const { timer, bounds } = request({ deadlineMs: 500 });
    const outcome = awaitTerminationWithinRequest(new Promise(() => {}), bounds);
    let result: string | undefined;
    void outcome.then((value) => {
      result = value;
    });

    timer.advanceTime(499);
    await settle();
    expect(result).toBeUndefined();
    timer.advanceTime(1);
    await settle();
    expect(result).toBe("pending");
  });

  it("stops waiting when the caller aborts during the wait, without touching the reason", async () => {
    const controller = new AbortController();
    const { bounds } = request({ signal: controller.signal });
    const reason = new Error("caller cancelled");
    const outcome = awaitTerminationWithinRequest(new Promise(() => {}), bounds);

    controller.abort(reason);

    expect(await outcome).toBe("pending");
    expect(reason.message).toBe("caller cancelled");
  });

  it("does not wait at all for a request that is already aborted or out of budget", async () => {
    const aborted = new AbortController();
    aborted.abort(new Error("already cancelled"));
    const never = new Promise<OwnedTermination>(() => {});

    expect(
      await awaitTerminationWithinRequest(never, request({ signal: aborted.signal }).bounds),
    ).toBe("pending");
    expect(await awaitTerminationWithinRequest(never, request({ deadlineMs: 0 }).bounds)).toBe(
      "pending",
    );
  });
});
