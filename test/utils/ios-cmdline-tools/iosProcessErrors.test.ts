import { expect, describe, test } from "bun:test";
import { isProcessAlreadyGoneError } from "../../../src/utils/ios-cmdline-tools/iosProcessErrors";

// Shared canonical matcher for "the app's process was already gone, so the
// terminate is an effective no-op success" (issue #3076). It covers the
// phrasings common to both the simulator (`simctl terminate`) and the physical
// device (`devicectl device process terminate`) paths. Each call site OR-s in
// its own tool-specific extras on top of this.
//
// PARAM-4 (#4177): collapsed into one decision table so every phrasing — and,
// crucially, every NON-match (device-scoped "not running", devicectl-only
// extras) — is a first-class row. The device/daemon-scoped rows are the
// load-bearing ones: mistaking them for an already-exited PID would let a
// disconnected device masquerade as a terminated app.
describe("isProcessAlreadyGoneError", () => {
  const rows: ReadonlyArray<{ message: string; expected: boolean }> = [
    // Already-gone: ESRCH strerror phrasing (case-insensitive).
    { message: "No such process", expected: true },
    { message: "The operation couldn’t be completed. No such process", expected: true },
    { message: "NO SUCH PROCESS", expected: true },
    // Already-gone: simctl "nothing to kill".
    { message: "found nothing to terminate", expected: true },
    { message: "Unable to terminate: found nothing to terminate", expected: true },
    { message: "FOUND NOTHING TO TERMINATE", expected: true },
    // Already-gone: process-scoped "not running", with and without "is".
    { message: "The process is not running", expected: true },
    { message: "process not running", expected: true },
    { message: "PROCESS IS NOT RUNNING", expected: true },
    // Unrelated hard failures must propagate.
    { message: "The device is locked.", expected: false },
    { message: "Could not connect to the device.", expected: false },
    { message: "Unable to terminate: permission denied", expected: false },
    { message: "", expected: false },
    // "not running" scoped to the DEVICE/CoreDevice, never the process.
    { message: "The device is not running.", expected: false },
    { message: "device not running", expected: false },
    { message: "CoreDevice tunnel is not running", expected: false },
    { message: "the daemon is not running", expected: false },
    // devicectl-only extras are OR-ed in at the call site, NOT here.
    { message: "NSPOSIXErrorDomain error 3", expected: false },
    { message: "The process is no longer running", expected: false },
    // A bare unrelated code.
    { message: "error 42", expected: false },
  ];

  for (const { message, expected } of rows) {
    test(`${expected ? "matches" : "does not match"}: ${JSON.stringify(message)}`, () => {
      expect(isProcessAlreadyGoneError(message)).toBe(expected);
    });
  }
});
