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
      onStateChange: state => states.push(state),
    });

    await controller.start();

    expect(controller.getState()).toBe("connected");
    expect(states).toEqual(["connecting", "connected"]);
  });

  test("retries with backoff until an attempt succeeds", async () => {
    const timer = new FakeTimer();
    let attempts = 0;
    const controller = new ReconnectController({
      attempt: async () => {
        attempts++;
        if (attempts < 3) {
          throw new Error("boom");
        }
      },
      backoff: [1000, 2000, 4000],
      timer,
    });

    await controller.start();
    expect(attempts).toBe(1);
    expect(controller.getState()).toBe("reconnecting");

    // First retry after 1000ms.
    timer.advanceTime(1000);
    await drain();
    expect(attempts).toBe(2);

    // Second retry after 2000ms succeeds.
    timer.advanceTime(2000);
    await drain();
    expect(attempts).toBe(3);
    expect(controller.getState()).toBe("connected");
  });

  test("gives up after maxAttempts and reports failed", async () => {
    const timer = new FakeTimer();
    let attempts = 0;
    const controller = new ReconnectController({
      attempt: async () => {
        attempts++;
        throw new Error("always fails");
      },
      backoff: 500,
      maxAttempts: 3,
      timer,
    });

    await controller.start();
    expect(attempts).toBe(1);

    timer.advanceTime(500);
    await drain();
    expect(attempts).toBe(2);

    timer.advanceTime(500);
    await drain();
    expect(attempts).toBe(3);
    expect(controller.getState()).toBe("failed");

    // No further retries once failed.
    timer.advanceTime(5000);
    await drain();
    expect(attempts).toBe(3);
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

  test("notifyConnectionLost is ignored while a cycle is active", async () => {
    const timer = new FakeTimer();
    let attempts = 0;
    const controller = new ReconnectController({
      attempt: async () => {
        attempts++;
        throw new Error("fail");
      },
      backoff: 1000,
      timer,
    });

    await controller.start();
    expect(attempts).toBe(1);
    // A spurious connection-lost while already retrying must not double-spawn.
    controller.notifyConnectionLost();
    controller.notifyConnectionLost();
    await drain();
    expect(attempts).toBe(1);
  });

  test("stop cancels pending retries", async () => {
    const timer = new FakeTimer();
    let attempts = 0;
    const controller = new ReconnectController({
      attempt: async () => {
        attempts++;
        throw new Error("fail");
      },
      backoff: 1000,
      timer,
    });

    await controller.start();
    expect(attempts).toBe(1);
    controller.stop();
    timer.advanceTime(5000);
    await drain();
    expect(attempts).toBe(1);
    expect(controller.getState()).toBe("stopped");
  });
});

/** Let queued microtasks (async attempt bodies) settle after advancing time. */
async function drain(): Promise<void> {
  for (let i = 0; i < 5; i++) {
    await Promise.resolve();
  }
}
