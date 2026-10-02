import { expect, spyOn, test } from "bun:test";
import { StreamDeviceLifecycleEmitter } from "../../src/daemon/streamDeviceLifecycleEvents";
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
