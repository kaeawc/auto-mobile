import { describe, expect, test } from "bun:test";
import {
  ReconnectController,
  type ReconnectState,
} from "../../../src/features/webrtc/ReconnectController";
import { FakeTimer } from "../../fakes/FakeTimer";

describe("ReconnectController", () => {
  test("start resolves connected on first success", async () => {
    const states: ReconnectState[] = [];
    const controller = new ReconnectController({
      attempt: async () => {},
      timer: new FakeTimer(),
      onStateChange: (state) => states.push(state),
    });

    await controller.start();

    expect(controller.getState()).toBe("connected");
    expect(states).toEqual(["connecting", "connected"]);
  });

  test("start rejects on the first-attempt failure and reports failed (no silent retry)", async () => {
    const controller = new ReconnectController({
      attempt: async () => {
        throw new Error("bad token");
      },
      timer: new FakeTimer(),
    });

    await expect(controller.start()).rejects.toThrow("bad token");
    expect(controller.getState()).toBe("failed");
  });

  test("reconnect retries with backoff until an attempt succeeds", async () => {
    const timer = new FakeTimer();
    let attempts = 0;
    const controller = new ReconnectController({
      attempt: async () => {
        attempts++;
        // attempt 1 (start) succeeds; reconnect attempts 2 & 3 fail; 4 succeeds.
        if (attempts > 1 && attempts <= 3) {
          throw new Error("boom");
        }
      },
      backoff: [1000, 2000, 4000],
      timer,
    });

    await controller.start();
    expect(attempts).toBe(1);
    expect(controller.getState()).toBe("connected");

    controller.notifyConnectionLost();
    await drain();
    expect(attempts).toBe(2);
    expect(controller.getState()).toBe("reconnecting");

    timer.advanceTime(1000);
    await drain();
    expect(attempts).toBe(3);

    timer.advanceTime(2000);
    await drain();
    expect(attempts).toBe(4);
    expect(controller.getState()).toBe("connected");
  });

  test("reconnect gives up after maxAttempts and reports failed", async () => {
    const timer = new FakeTimer();
    let attempts = 0;
    const controller = new ReconnectController({
      attempt: async () => {
        attempts++;
        if (attempts > 1) {
          throw new Error("always fails");
        }
      },
      backoff: 500,
      maxAttempts: 3,
      timer,
    });

    await controller.start();
    controller.notifyConnectionLost();
    await drain();
    expect(attempts).toBe(2);

    timer.advanceTime(500);
    await drain();
    expect(attempts).toBe(3);

    timer.advanceTime(500);
    await drain();
    expect(attempts).toBe(4);
    expect(controller.getState()).toBe("failed");

    // No further retries once failed.
    timer.advanceTime(5000);
    await drain();
    expect(attempts).toBe(4);
  });

  test("notifyConnectionLost triggers a fresh reconnect cycle", async () => {
    const timer = new FakeTimer();
    let attempts = 0;
    const controller = new ReconnectController({
      attempt: async () => {
        attempts++;
      },
      timer,
    });

    await controller.start();
    expect(attempts).toBe(1);
    expect(controller.getState()).toBe("connected");

    controller.notifyConnectionLost();
    await drain();
    expect(attempts).toBe(2);
    expect(controller.getState()).toBe("connected");
  });

  test("queues a connection-lost that races the in-flight connect (not dropped)", async () => {
    const timer = new FakeTimer();
    let attempts = 0;
    let firedDuringConnect = false;
    const controller = new ReconnectController({
      attempt: async () => {
        attempts++;
        // Simulate a capture-source failure reported synchronously while the
        // first connect is still in-flight (cycleActive / connecting).
        if (attempts === 1 && !firedDuringConnect) {
          firedDuringConnect = true;
          controller.notifyConnectionLost();
        }
      },
      timer,
    });

    await controller.start();
    await drain();

    // The queued reconnect ran once the connect settled rather than being dropped.
    expect(attempts).toBe(2);
    expect(controller.getState()).toBe("connected");
  });

  test("stop cancels pending reconnect retries", async () => {
    const timer = new FakeTimer();
    let attempts = 0;
    const controller = new ReconnectController({
      attempt: async () => {
        attempts++;
        // start succeeds; the reconnect attempt fails and schedules a retry.
        if (attempts > 1) {
          throw new Error("fail");
        }
      },
      backoff: 1000,
      timer,
    });

    await controller.start();
    controller.notifyConnectionLost();
    await drain();
    expect(attempts).toBe(2);

    controller.stop();
    timer.advanceTime(5000);
    await drain();
    expect(attempts).toBe(2);
    expect(controller.getState()).toBe("stopped");
  });

  test("stop during an in-flight reconnect remains stopped when that attempt succeeds", async () => {
    const timer = new FakeTimer();
    let resolveReconnect: (() => void) | undefined;
    let attempts = 0;
    const controller = new ReconnectController({
      attempt: async () => {
        attempts++;
        if (attempts === 2) {
          await new Promise<void>((resolve) => {
            resolveReconnect = resolve;
          });
        }
      },
      timer,
    });

    await controller.start();
    controller.notifyConnectionLost();
    await drain();
    controller.stop();
    resolveReconnect?.();
    await drain();

    expect(controller.getState()).toBe("stopped");
  });

  test("the default reconnect backoff climbs 1s→2s→4s… and caps at 30s", async () => {
    // No injected backoff: exercise the constructor default (exponential
    // 1s→30s, ×2). Drive the ladder through notifyConnectionLost() since start()
    // deliberately does not enter the retry loop.
    const timer = new FakeTimer();
    const controller = new ReconnectController({
      attempt: async () => {
        throw new Error("still down");
      },
      timer,
    });

    const rungs: number[] = [];
    controller.notifyConnectionLost();
    await drain();
    rungs.push(timer.getPendingTimeouts()[0]);

    // Each failed attempt schedules the next rung; walk seven rungs to see the
    // 30s ceiling engage (attempt 6 would be 32s uncapped).
    for (let i = 0; i < 6; i++) {
      const delay = timer.getPendingTimeouts()[0];
      timer.advanceTime(delay);
      await drain();
      rungs.push(timer.getPendingTimeouts()[0]);
    }

    expect(rungs).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });
});

/** Let queued microtasks (async attempt bodies) settle after advancing time. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}
