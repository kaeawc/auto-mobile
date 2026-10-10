import { describe, expect, test } from "bun:test";
import {
  createDeviceStateChangeNotifier,
  DEVICE_STATE_NOTIFY_DEBOUNCE_MS,
} from "../../src/server/deviceStateChangeNotifier";
import { FakeTimer } from "../fakes/FakeTimer";

describe("createDeviceStateChangeNotifier (#11413)", () => {
  test("invalidates immediately and coalesces a burst into one notification", () => {
    const timer = new FakeTimer();
    let invalidations = 0;
    let notifications = 0;
    const onChange = createDeviceStateChangeNotifier({
      timer,
      invalidate: () => {
        invalidations++;
      },
      notify: async () => {
        notifications++;
      },
    });

    onChange("a");
    onChange("b");
    expect(invalidations).toBe(2);
    expect(notifications).toBe(0);

    timer.advanceTime(DEVICE_STATE_NOTIFY_DEBOUNCE_MS);
    expect(notifications).toBe(1);

    onChange("a");
    timer.advanceTime(DEVICE_STATE_NOTIFY_DEBOUNCE_MS);
    expect(notifications).toBe(2);
  });

  test("a failed notification neither throws nor blocks the next burst", async () => {
    const timer = new FakeTimer();
    let attempts = 0;
    const onChange = createDeviceStateChangeNotifier({
      timer,
      invalidate: () => {},
      notify: async () => {
        attempts++;
        throw new Error("send failed");
      },
    });
    onChange("a");
    timer.advanceTime(DEVICE_STATE_NOTIFY_DEBOUNCE_MS);
    await Promise.resolve();
    onChange("a");
    timer.advanceTime(DEVICE_STATE_NOTIFY_DEBOUNCE_MS);
    expect(attempts).toBe(2);
  });
});
