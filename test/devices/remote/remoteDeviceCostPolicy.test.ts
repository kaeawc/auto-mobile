import { describe, expect, test } from "bun:test";
import {
  assertRemoteDeviceRequestAllowed,
  estimateRemoteDeviceCost,
} from "../../../src/devices/remote/remoteDeviceCostPolicy";
import { remainingSessionMs } from "../../../src/devices/remote/remoteDeviceProvider";

const guards = { optIn: true, maxSessionMinutes: 30 };

describe("estimateRemoteDeviceCost", () => {
  test("prices every minute at the published rate as the upper bound", () => {
    expect(estimateRemoteDeviceCost(20)).toEqual({
      minutes: 20,
      usdPerMinute: 0.15,
      maxUsd: 3,
      freeMinutesPerProjectPerMonth: 30,
    });
  });

  test("rounds to cents", () => {
    expect(estimateRemoteDeviceCost(7).maxUsd).toBe(1.05);
  });
});

describe("assertRemoteDeviceRequestAllowed", () => {
  test("refuses everything without an explicit opt-in", () => {
    expect(() => assertRemoteDeviceRequestAllowed({ ...guards, optIn: false }, 5)).toThrow(
      /off by default/,
    );
  });

  test("refuses non-positive and fractional minutes", () => {
    expect(() => assertRemoteDeviceRequestAllowed(guards, 0)).toThrow(/positive whole number/);
    expect(() => assertRemoteDeviceRequestAllowed(guards, 1.5)).toThrow(/positive whole number/);
  });

  test("allows a request at the cap and refuses one over it, quoting the cost", () => {
    expect(() => assertRemoteDeviceRequestAllowed(guards, 30)).not.toThrow();
    expect(() => assertRemoteDeviceRequestAllowed(guards, 31)).toThrow(
      /31-minute remote session exceeds the 30-minute cap \(up to \$4\.65\)/,
    );
  });

  test("checks the whole session length for an extension", () => {
    expect(() => assertRemoteDeviceRequestAllowed(guards, 10, 35)).toThrow(/35-minute/);
  });
});

describe("remainingSessionMs", () => {
  test("counts down to the expire time and never goes negative", () => {
    expect(remainingSessionMs({ state: "active", expireTimeMs: 90_000 }, 30_000)).toBe(60_000);
    expect(remainingSessionMs({ state: "active", expireTimeMs: 90_000 }, 120_000)).toBe(0);
  });

  test("is zero once the session ended and unknown without an end time", () => {
    expect(remainingSessionMs({ state: "expired", expireTimeMs: 90_000 }, 0)).toBe(0);
    expect(remainingSessionMs({ state: "pending" }, 0)).toBeUndefined();
  });
});
