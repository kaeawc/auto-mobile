import { describe, expect, test } from "bun:test";
import {
  assertInputRequesterHoldsDevice,
  DEVICE_OWNED_BY_OTHER_SESSION_CODE,
  InputDeviceOwnedError,
  parseInputRequesterSessionUuid,
} from "../../src/daemon/inputDeviceOwnership";

const labels = {
  getDeviceLabels: (uuid: string) => (uuid === "agent" ? { phone: "agent:phone" } : undefined),
};

function check(ownerSessionUuid: string | undefined, requesterSessionUuid: string | undefined) {
  return () =>
    assertInputRequesterHoldsDevice({
      action: "input/tap",
      deviceId: "emulator-5554",
      ownerSessionUuid,
      requesterSessionUuid,
      sessionManager: labels,
    });
}

describe("assertInputRequesterHoldsDevice (#10698)", () => {
  test("an unowned device takes input from anyone, sessionless included", () => {
    expect(check(undefined, undefined)).not.toThrow();
    expect(check(undefined, "desktop")).not.toThrow();
  });

  test("the holder may drive its device, by base or derived label session", () => {
    expect(check("agent", "agent")).not.toThrow();
    expect(check("agent:phone", "agent")).not.toThrow();
    expect(check("agent", "agent:phone")).not.toThrow();
  });

  test("a sessionless or foreign frame on a held device is refused with the typed code", () => {
    for (const requester of [undefined, "desktop"]) {
      let thrown: unknown;
      try {
        check("agent", requester)();
      } catch (error) {
        thrown = error;
      }
      expect(thrown).toBeInstanceOf(InputDeviceOwnedError);
      expect((thrown as InputDeviceOwnedError).code).toBe(DEVICE_OWNED_BY_OTHER_SESSION_CODE);
      expect((thrown as Error).message).toContain("emulator-5554");
    }
  });
});

describe("parseInputRequesterSessionUuid", () => {
  test("reads an optional non-empty string", () => {
    expect(parseInputRequesterSessionUuid("input/tap", { platform: "android" })).toBeUndefined();
    expect(parseInputRequesterSessionUuid("input/tap", undefined)).toBeUndefined();
    expect(parseInputRequesterSessionUuid("input/tap", { sessionUuid: " d " })).toBe("d");
  });

  test("rejects a malformed value", () => {
    expect(() => parseInputRequesterSessionUuid("input/tap", { sessionUuid: "" })).toThrow(
      /non-empty string/,
    );
    expect(() => parseInputRequesterSessionUuid("input/key", { sessionUuid: 7 })).toThrow(
      /input\/key sessionUuid/,
    );
  });
});
