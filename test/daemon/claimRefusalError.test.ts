import { describe, expect, test } from "bun:test";
import { claimRefusalError } from "../../src/daemon/claimRefusalError";
import {
  DEVICE_OWNED_BY_OTHER_DAEMON_CODE,
  DeviceOwnedByOtherDaemonError,
} from "../../src/models/deviceAcquisitionRefusals";

function ownership(deferred: boolean, ownerPid: number | undefined) {
  return {
    claimDeferred: () => deferred,
    foreignOwnerPid: () => ownerPid,
  };
}

describe("claimRefusalError (#11811)", () => {
  test("a claim the table could not decide says the registry is unusable, not that a daemon holds it", () => {
    const error = claimRefusalError(ownership(true, undefined), "emulator-5554");

    expect(error).toBeInstanceOf(DeviceOwnedByOtherDaemonError);
    expect(error.code).toBe(DEVICE_OWNED_BY_OTHER_DAEMON_CODE);
    expect(error.retryable).toBe(true);
    expect(error.ownerPid).toBeUndefined();
    expect(error.message).toContain("device claims registry cannot decide it right now");
    expect(error.message).toContain("No other AutoMobile daemon was seen holding it");
    expect(error.message).not.toContain("is claimed by another AutoMobile daemon");
  });

  test("a claim a live foreign daemon holds names that daemon and keeps the remedy", () => {
    const error = claimRefusalError(ownership(false, 4242), "emulator-5554", "Stop it there.");

    expect(error.code).toBe(DEVICE_OWNED_BY_OTHER_DAEMON_CODE);
    expect(error.ownerPid).toBe(4242);
    expect(error.message).toContain("is claimed by another AutoMobile daemon (PID 4242)");
    expect(error.message).toContain("Stop it there.");
  });

  test("ownership without claimDeferred and no ownership both fall back to the foreign-owner wording", () => {
    const withoutDeferred = claimRefusalError({ foreignOwnerPid: () => 7 }, "d1");
    const none = claimRefusalError(undefined, "d2");

    expect(withoutDeferred.message).toContain("(PID 7)");
    expect(none.ownerPid).toBeUndefined();
    expect(none.message).toContain("Device 'd2' is claimed by another AutoMobile daemon (code");
  });
});
