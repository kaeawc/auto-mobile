import { describe, expect, test } from "bun:test";
import fc from "fast-check";
import {
  holderOf,
  statusOf,
  isIdle,
  isBusy,
  isErrored,
  type BindingFields,
} from "../../src/daemon/deviceBinding";

describe("device binding readers", () => {
  test("holderOf preserves the holder and nullish-device overloads", () => {
    const holder: string | null = holderOf({ sessionId: "a" });
    const maybeDevice = (device: Pick<BindingFields, "sessionId"> | null | undefined) => {
      const maybeHolder: string | null | undefined = holderOf(device);
      return maybeHolder;
    };
    expect(holder).toBe("a");
    expect(holderOf({ sessionId: null })).toBeNull();
    expect(holderOf({ sessionId: "" })).toBe("");
    expect(maybeDevice({ sessionId: "a" })).toBe("a");
    expect(maybeDevice(null)).toBeUndefined();
    expect(maybeDevice(undefined)).toBeUndefined();
  });

  test("statusOf preserves every status", () => {
    for (const status of ["idle", "busy", "error"] as const) {
      expect(statusOf({ status })).toBe(status);
    }
  });

  test("isIdle compares status and rejects nullish devices", () => {
    expect(isIdle({ status: "idle" })).toBe(true);
    expect(isIdle({ status: "busy" })).toBe(false);
    expect(isIdle({ status: "error" })).toBe(false);
    expect(isIdle(null)).toBe(false);
    expect(isIdle(undefined)).toBe(false);
  });

  test("isBusy compares status and rejects nullish devices", () => {
    expect(isBusy({ status: "idle" })).toBe(false);
    expect(isBusy({ status: "busy" })).toBe(true);
    expect(isBusy({ status: "error" })).toBe(false);
    expect(isBusy(null)).toBe(false);
    expect(isBusy(undefined)).toBe(false);
  });

  test("isErrored compares status and rejects nullish devices", () => {
    expect(isErrored({ status: "idle" })).toBe(false);
    expect(isErrored({ status: "busy" })).toBe(false);
    expect(isErrored({ status: "error" })).toBe(true);
    expect(isErrored(null)).toBe(false);
    expect(isErrored(undefined)).toBe(false);
  });

  const assertReaders = (device: BindingFields) => {
    expect(holderOf(device)).toBe(device.sessionId);
    expect(statusOf(device)).toBe(device.status);
    expect(isIdle(device)).toBe(device.status === "idle");
    expect(isBusy(device)).toBe(device.status === "busy");
    expect(isErrored(device)).toBe(device.status === "error");
    expect(!isIdle(device)).toBe(device.status !== "idle");
  };

  test("readers equal raw reads across all nine binding tuples", () => {
    for (const status of ["idle", "busy", "error"] as const) {
      for (const sessionId of [null, "", "a"]) {
        assertReaders({ status, sessionId });
      }
    }
  });

  test("readers equal raw reads for generated binding states", () => {
    fc.assert(
      fc.property(
        fc.record({
          status: fc.constantFrom("idle" as const, "busy" as const, "error" as const),
          sessionId: fc.oneof(fc.constant(null), fc.string({ maxLength: 32 })),
        }),
        assertReaders,
      ),
      { numRuns: 100, seed: 11802 },
    );
  });
});
