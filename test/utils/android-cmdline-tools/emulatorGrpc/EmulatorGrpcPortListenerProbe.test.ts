import { describe, expect, test } from "bun:test";
import { isNoListenerConnectError } from "../../../../src/utils/android-cmdline-tools/emulatorGrpc/EmulatorGrpcPortListenerProbe";

function connectError(code: string): NodeJS.ErrnoException {
  return Object.assign(new Error(`connect ${code}`), { code });
}

describe("isNoListenerConnectError", () => {
  test.each(["ECONNREFUSED", "EADDRNOTAVAIL", "EAFNOSUPPORT", "ENETUNREACH"])(
    "%s means nothing listens there",
    (code) => {
      expect(isNoListenerConnectError(connectError(code))).toBe(true);
    },
  );

  test.each(["EACCES", "EPERM", "ECONNRESET", "EMFILE"])(
    "%s leaves the listener state unknown",
    (code) => {
      expect(isNoListenerConnectError(connectError(code))).toBe(false);
    },
  );

  test("an error without a code leaves the listener state unknown", () => {
    expect(isNoListenerConnectError(new Error("socket hang up"))).toBe(false);
    expect(isNoListenerConnectError(undefined)).toBe(false);
  });
});
