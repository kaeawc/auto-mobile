import { describe, expect, test } from "bun:test";
import {
  forwardingLeaseConflictCause,
  type ForwardingLeaseConflictLookup,
} from "../../src/server/forwardingLeaseConflictOutcome";
import { CtrlProxyForwardingLeaseConflictError } from "../../src/features/observe/shared/CtrlProxyForwardingLeaseConflictError";
import { MissingViewHierarchyError } from "../../src/features/action/MissingViewHierarchyError";
import { ActionableError } from "../../src/models/ActionableError";
import { DeviceLostError } from "../../src/models/DeviceLostError";

const DEVICE = "emulator-5600";
const MESSAGE =
  "Another AutoMobile process (PID 15836, socket /tmp/ovl-priv/daemon.sock) owns CtrlProxy forwarding for emulator-5600";

/** The device's client: its latest connect failed on the lease, or it did not. */
function lookup(conflicted: boolean): ForwardingLeaseConflictLookup {
  return (deviceId) => (conflicted && deviceId === DEVICE ? MESSAGE : undefined);
}

describe("forwardingLeaseConflictCause (#10485)", () => {
  test("explains a missing hierarchy on a device whose latest connect hit the lease", () => {
    const cause = forwardingLeaseConflictCause(
      new MissingViewHierarchyError(),
      new Set([DEVICE]),
      lookup(true),
    );
    expect(cause).toBeInstanceOf(ActionableError);
    expect(cause?.message).toBe(MESSAGE);
  });

  test("leaves a missing hierarchy alone once a fresh connect cleared the conflict", () => {
    expect(
      forwardingLeaseConflictCause(new MissingViewHierarchyError(), [DEVICE], lookup(false)),
    ).toBeUndefined();
  });

  test("never hijacks device loss or unrelated (adb-only) failures", () => {
    for (const error of [
      new DeviceLostError(DEVICE, "gone"),
      new ActionableError("Failed to install APK: INSTALL_FAILED_INSUFFICIENT_STORAGE"),
      new Error("adb: device offline"),
    ]) {
      expect(forwardingLeaseConflictCause(error, [DEVICE], lookup(true))).toBeUndefined();
    }
  });

  test("ignores other devices", () => {
    expect(
      forwardingLeaseConflictCause(
        new MissingViewHierarchyError(),
        ["emulator-5554"],
        lookup(true),
      ),
    ).toBeUndefined();
  });

  test("surfaces a conflict found in the cause chain", () => {
    const conflict = new CtrlProxyForwardingLeaseConflictError(MESSAGE, 15836);
    expect(forwardingLeaseConflictCause(conflict, [], lookup(false))?.message).toBe(MESSAGE);
    const wrapped = new ActionableError("observe failed", { cause: conflict });
    expect(forwardingLeaseConflictCause(wrapped, [], lookup(false))?.message).toBe(MESSAGE);
  });

  test("keeps a failure that already names the conflict", () => {
    const conflict = new CtrlProxyForwardingLeaseConflictError(MESSAGE, 15836);
    expect(
      forwardingLeaseConflictCause(
        new Error(`getAndroid automation runner readiness failed: ${MESSAGE}`, { cause: conflict }),
        [DEVICE],
        lookup(true),
      ),
    ).toBeUndefined();
  });
});
