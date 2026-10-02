import { expect, spyOn, test } from "bun:test";
import {
  getDaemonStreamDeviceLifecycleEmitter,
  StreamDeviceLifecycleEmitter,
} from "../../src/daemon/streamDeviceLifecycleEvents";
import { getDeviceIncarnationListeners } from "../../src/utils/deviceIncarnation";
import { logger } from "../../src/utils/logger";

test("lifecycle emitter isolates failures, routes events and unsubscribes", () => {
  const events = new StreamDeviceLifecycleEmitter();
  const seen: string[] = [];
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const removeBad = events.onDeviceRemoved(() => {
      throw new Error("listener failed");
    });
    const remove = events.onDeviceRemoved((id) => seen.push(`removed:${id}`));
    const identity = events.onDeviceIdentityChanged((id) => seen.push(`identity:${id}`));
    events.deviceRemoved("device");
    events.deviceIdentityChanged("device");
    expect(seen).toEqual(["removed:device", "identity:device"]);
    expect(warning).toHaveBeenCalledTimes(1);
    removeBad();
    remove();
    identity();
    events.deviceRemoved("device");
    events.deviceIdentityChanged("device");
    expect(seen).toHaveLength(2);
  } finally {
    warning.mockRestore();
  }
});

test("restore delivery isolates failures and unsubscribes independently", () => {
  const events = new StreamDeviceLifecycleEmitter();
  const seen: string[] = [];
  const warning = spyOn(logger, "warn").mockImplementation(() => {});
  try {
    const removeBad = events.onDeviceRestored(() => {
      throw new Error("restore listener failed");
    });
    const remove = events.onDeviceRestored((id) => seen.push(id));
    events.deviceRemoved("other");
    events.deviceIdentityChanged("other");
    events.deviceRestored("device");
    expect(seen).toEqual(["device"]);
    expect(warning).toHaveBeenCalledTimes(1);
    removeBad();
    remove();
    events.deviceRestored("device");
    expect(seen).toEqual(["device"]);
  } finally {
    warning.mockRestore();
  }
});

test("lazy daemon emitter registers restore delivery before and after incarnation change", async () => {
  const emitter = getDaemonStreamDeviceLifecycleEmitter();
  const listener = getDeviceIncarnationListeners().find(
    (entry) => entry.name === "stream-device-lifecycle",
  );
  expect(listener).toBeDefined();
  const restored = spyOn(emitter, "deviceRestored").mockImplementation(() => {});
  try {
    expect(getDaemonStreamDeviceLifecycleEmitter()).toBe(emitter);
    expect(
      getDeviceIncarnationListeners().filter((entry) => entry.name === listener?.name),
    ).toHaveLength(1);
    await listener?.prepareForIncarnationChange?.("device");
    await listener?.onDeviceIncarnationChanged("device");
    expect(restored.mock.calls).toEqual([["device"], ["device"]]);
  } finally {
    restored.mockRestore();
  }
});
