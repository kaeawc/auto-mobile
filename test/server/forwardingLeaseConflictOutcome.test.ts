import { afterEach, describe, expect, test } from "bun:test";
import { forwardingLeaseConflictCause } from "../../src/server/forwardingLeaseConflictOutcome";
import {
  CtrlProxyForwardingLeaseConflictError,
  FORWARDING_LEASE_CONFLICT_TTL_MS,
  clearForwardingLeaseConflict,
  recordForwardingLeaseConflict,
} from "../../src/features/observe/shared/CtrlProxyForwardingLeaseConflictError";
import { ActionableError } from "../../src/models/ActionableError";
import { DeviceLostError } from "../../src/models/DeviceLostError";
import { FakeTimer } from "../fakes/FakeTimer";

const DEVICE = "emulator-5600";
const conflict = new CtrlProxyForwardingLeaseConflictError(
  "Another AutoMobile process (PID 15836, socket /tmp/ovl-priv/daemon.sock) owns CtrlProxy forwarding for emulator-5600",
  15836,
  "/tmp/ovl-priv/daemon.sock",
);

describe("forwardingLeaseConflictCause (#10485)", () => {
  afterEach(() => clearForwardingLeaseConflict(DEVICE));

  test("reports a recorded conflict instead of a missing hierarchy", () => {
    const timer = new FakeTimer();
    recordForwardingLeaseConflict(DEVICE, conflict, timer);
    const cause = forwardingLeaseConflictCause(
      new ActionableError("Cannot perform action without view hierarchy"),
      new Set([DEVICE]),
      timer,
    );
    expect(cause).toBeInstanceOf(ActionableError);
    expect(cause?.message).toBe(conflict.message);
  });

  test("reports a recorded conflict instead of device loss", () => {
    const timer = new FakeTimer();
    recordForwardingLeaseConflict(DEVICE, conflict, timer);
    expect(
      forwardingLeaseConflictCause(new DeviceLostError(DEVICE, "gone"), [DEVICE], timer)?.message,
    ).toBe(conflict.message);
  });

  test("ignores other devices, cleared conflicts, and expired conflicts", () => {
    const timer = new FakeTimer();
    recordForwardingLeaseConflict(DEVICE, conflict, timer);
    expect(forwardingLeaseConflictCause(new Error("x"), ["emulator-5554"], timer)).toBeUndefined();
    expect(forwardingLeaseConflictCause(new Error("x"), undefined, timer)).toBeUndefined();
    timer.advanceTime(FORWARDING_LEASE_CONFLICT_TTL_MS);
    expect(forwardingLeaseConflictCause(new Error("x"), [DEVICE], timer)).toBeUndefined();
    recordForwardingLeaseConflict(DEVICE, conflict, timer);
    clearForwardingLeaseConflict(DEVICE);
    expect(forwardingLeaseConflictCause(new Error("x"), [DEVICE], timer)).toBeUndefined();
  });

  test("keeps a failure that already names the conflict", () => {
    const timer = new FakeTimer();
    recordForwardingLeaseConflict(DEVICE, conflict, timer);
    expect(
      forwardingLeaseConflictCause(
        new Error(`getAndroid automation runner readiness failed: ${conflict.message}`),
        [DEVICE],
        timer,
      ),
    ).toBeUndefined();
  });

  test("wraps a thrown conflict as an actionable error", () => {
    expect(forwardingLeaseConflictCause(conflict, [])?.message).toBe(conflict.message);
  });
});
