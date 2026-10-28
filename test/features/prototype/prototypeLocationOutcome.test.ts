import { describe, expect, test } from "bun:test";
import {
  applyPrototypeLocationOutcome,
  prototypeLocationFixError,
  type PrototypeLocationFix,
} from "../../../src/features/prototype/prototypeLocationOutcome";

const fix: PrototypeLocationFix = {
  latitude: 37.7749,
  longitude: -122.4194,
  accuracyM: 12,
  timestampMs: 1_700_000_000_000,
  approximate: false,
};
const data = { here: {}, other: 1 };

describe("applyPrototypeLocationOutcome", () => {
  test("writes a precise fix to into and its metadata beside it", () => {
    const result = applyPrototypeLocationOutcome(data, "/data/here", {
      ok: true,
      fix: { ...fix, speedMps: 3 },
      durationMs: 40,
    });
    expect(result.status).toBe("success");
    expect(result.wroteInto).toBe(true);
    expect(result.data).toEqual({
      here: { ...fix, speedMps: 3 },
      here__meta: { durationMs: 40, approximate: false },
      other: 1,
    });
  });

  test("an approximate-only grant is a success that says so", () => {
    const result = applyPrototypeLocationOutcome(data, "/data/here", {
      ok: true,
      fix: { ...fix, accuracyM: 3000, approximate: true },
      durationMs: 5,
    });
    expect(result.status).toBe("success");
    expect(result.data.here).toMatchObject({ approximate: true, accuracyM: 3000 });
    expect(result.meta).toEqual({ durationMs: 5, approximate: true });
  });

  test("permission_denied and timeout leave into untouched and record the typed error", () => {
    for (const code of ["permission_denied", "timeout"] as const) {
      const result = applyPrototypeLocationOutcome(data, "/data/here", {
        ok: false,
        error: { code, message: code },
        durationMs: 9,
      });
      expect(result.status).toBe("error");
      expect(result.wroteInto).toBe(false);
      expect(result.data.here).toEqual({});
      expect(result.data.here__meta).toEqual({ durationMs: 9, error: { code, message: code } });
    }
  });

  test("location services off is unavailable with reason disabled", () => {
    const result = applyPrototypeLocationOutcome(data, "/data/here", {
      ok: false,
      error: { code: "unavailable", message: "Location is off", reason: "disabled" },
      durationMs: 1,
    });
    expect(result.meta.error).toEqual({
      code: "unavailable",
      message: "Location is off",
      reason: "disabled",
    });
  });

  test("an unknown code becomes platform_error and drops a reason it cannot carry", () => {
    const result = applyPrototypeLocationOutcome(data, "/data/here", {
      ok: false,
      error: { code: "gps_on_fire", message: "boom", reason: "disabled" },
      durationMs: 2,
    });
    expect(result.meta.error).toEqual({ code: "platform_error", message: "boom" });
  });

  test("an out-of-range fix is a platform_error and nothing is written to into", () => {
    const result = applyPrototypeLocationOutcome(data, "/data/here", {
      ok: true,
      fix: { ...fix, latitude: 91 },
      durationMs: 3,
    });
    expect(result.status).toBe("error");
    expect(result.data.here).toEqual({});
    expect(result.meta.error?.code).toBe("platform_error");
  });

  test("without into the data is unchanged and only the status reports the outcome", () => {
    const result = applyPrototypeLocationOutcome(data, undefined, { ok: true, fix, durationMs: 4 });
    expect(result).toEqual({
      status: "success",
      data,
      meta: { durationMs: 4, approximate: false },
      wroteInto: false,
    });
  });

  test("an into whose parent is missing fails without partial writes", () => {
    const result = applyPrototypeLocationOutcome(data, "/data/missing/here", {
      ok: true,
      fix,
      durationMs: 6,
    });
    expect(result.status).toBe("error");
    expect(result.wroteInto).toBe(false);
    expect(result.data).toEqual(data);
  });
});

describe("prototypeLocationFixError", () => {
  test("accepts the coordinate bounds and refuses values past them", () => {
    expect(prototypeLocationFixError({ ...fix, latitude: -90, longitude: 180 })).toBeUndefined();
    expect(prototypeLocationFixError({ ...fix, longitude: -180.5 })).toBeDefined();
    expect(prototypeLocationFixError({ ...fix, accuracyM: -1 })).toBeDefined();
    expect(prototypeLocationFixError({ ...fix, bearingDeg: 361 })).toBe(
      "fix bearingDeg is out of range",
    );
    expect(prototypeLocationFixError({ ...fix, latitude: Number.NaN })).toBeDefined();
  });
});
