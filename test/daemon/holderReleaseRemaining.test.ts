import { expect, test } from "bun:test";
import { holderReleaseRemainingMs } from "../../src/daemon/holderReleaseRemaining";
import {
  heldDeviceBindRefusal,
  DEVICE_PREPARED_FOR_OTHER_REQUEST_RETRY_AFTER_MS,
} from "../../src/daemon/inputDeviceOwnership";

const query = (disconnectRemainingMs?: number, releasing = false) =>
  holderReleaseRemainingMs({ disconnectRemainingMs, releasing, ownerLease: undefined });

test("release hints take the minimum existing bound, round up and stay within the lease contract", () => {
  expect(query()).toBeUndefined();
  expect(query(50_000)).toBe(8_000);
  expect(query(-1)).toBe(1);
  expect(query(1.1)).toBe(2);
  expect(query(undefined, true)).toBe(DEVICE_PREPARED_FOR_OTHER_REQUEST_RETRY_AFTER_MS);
  expect(query(500, true)).toBe(500);
  expect(
    holderReleaseRemainingMs({
      disconnectRemainingMs: 6_000,
      releasing: false,
      ownerLease: { phase: "suspect", remainingMs: 3_000 },
    }),
  ).toBe(3_000);
  for (const phase of ["live", "lapsed"] as const) {
    expect(
      holderReleaseRemainingMs({
        disconnectRemainingMs: undefined,
        releasing: false,
        ownerLease: { phase, remainingMs: 1_000 },
      }),
    ).toBeUndefined();
  }
});

test("held-device helpers preserve old wording with absent query and append the retry explanation", () => {
  const old = heldDeviceBindRefusal({}, "device", "holder", "rival");
  expect(old.message).toBe("Device 'device' is already assigned to session holder");
  expect(old.toPayload()).toEqual({
    code: "device_owned_by_other_session",
    deviceId: "device",
    retryable: false,
  });
  const pool = { holderReleaseRemainingMs: () => 600 };
  const retry = heldDeviceBindRefusal(pool, "device", "holder", "rival");
  expect(retry.message).toBe(`${old.message}. The holder is being released; retry in about 600ms.`);
  expect(retry.toPayload()).toEqual({
    code: "device_owned_by_other_session",
    deviceId: "device",
    retryable: true,
    retryAfterMs: 600,
  });
  expect(heldDeviceBindRefusal(pool, "device", undefined, undefined, "another").retryable).toBe(
    false,
  );
});
