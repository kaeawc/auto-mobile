import { expect, describe, test } from "bun:test";
import { isProcessAlreadyGoneError } from "../../../src/utils/ios-cmdline-tools/iosProcessErrors";

// Shared canonical matcher for "the app's process was already gone, so the
// terminate is an effective no-op success" (issue #3076). It covers the
// phrasings common to both the simulator (`simctl terminate`) and the physical
// device (`devicectl device process terminate`) paths. Each call site OR-s in
// its own tool-specific extras on top of this.
describe("isProcessAlreadyGoneError", () => {
  test("matches the shared already-gone phrasings (case-insensitive)", () => {
    expect(isProcessAlreadyGoneError("No such process")).toBe(true);
    expect(isProcessAlreadyGoneError("The operation couldn’t be completed. No such process")).toBe(true);
    expect(isProcessAlreadyGoneError("found nothing to terminate")).toBe(true);
    expect(isProcessAlreadyGoneError("Unable to terminate: found nothing to terminate")).toBe(true);
    // Process-scoped "not running": with and without the "is".
    expect(isProcessAlreadyGoneError("The process is not running")).toBe(true);
    expect(isProcessAlreadyGoneError("process not running")).toBe(true);
    // Case-insensitive.
    expect(isProcessAlreadyGoneError("NO SUCH PROCESS")).toBe(true);
    expect(isProcessAlreadyGoneError("FOUND NOTHING TO TERMINATE")).toBe(true);
  });

  test("does not match unrelated failures", () => {
    expect(isProcessAlreadyGoneError("The device is locked.")).toBe(false);
    expect(isProcessAlreadyGoneError("Could not connect to the device.")).toBe(false);
    expect(isProcessAlreadyGoneError("Unable to terminate: permission denied")).toBe(false);
    expect(isProcessAlreadyGoneError("")).toBe(false);
  });

  test("scopes 'not running' to the process, never the device/CoreDevice", () => {
    // A device-level "not running" must NOT be swallowed as an already-exited
    // process — otherwise a disconnected device would masquerade as terminated.
    expect(isProcessAlreadyGoneError("The device is not running.")).toBe(false);
    expect(isProcessAlreadyGoneError("device not running")).toBe(false);
    expect(isProcessAlreadyGoneError("CoreDevice tunnel is not running")).toBe(false);
  });

  test("does NOT include devicectl-only extras (those OR-in at the call site)", () => {
    // The bare POSIX ESRCH code and the "no longer running" phrasing are
    // devicectl-specific; the shared helper stays minimal and simctl-safe.
    expect(isProcessAlreadyGoneError("NSPOSIXErrorDomain error 3")).toBe(false);
    expect(isProcessAlreadyGoneError("The process is no longer running")).toBe(false);
  });
});
