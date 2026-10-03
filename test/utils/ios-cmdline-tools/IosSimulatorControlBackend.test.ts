import { describe, expect, test } from "bun:test";
import {
  resolveIosDeviceKind,
  resolveIosKeychainControlBackend,
} from "../../../src/utils/ios-cmdline-tools/IosSimulatorControlBackend";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";

const simulatorUdid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const physicalUdid = "00008030-001C2D3E1234567A";

describe("resolveIosDeviceKind", () => {
  test("resolves a simulator UUID without invoking either transport", () => {
    expect(resolveIosDeviceKind({ deviceId: simulatorUdid })).toBe("simulator");
  });

  test.each([physicalUdid, "a".repeat(40), "unrecognized-device"])(
    "preserves the physical fallback for %s without transport access",
    (deviceId) => {
      expect(resolveIosDeviceKind({ deviceId })).toBe("physical");
    },
  );
});

describe("resolveIosKeychainControlBackend", () => {
  test("simulator reset preserves argv and the default timeout", async () => {
    const simctl = new FakeSimCtlClient();
    const backend = resolveIosKeychainControlBackend({ deviceId: simulatorUdid, simctl });

    expect(backend.kind).toBe("simulator");
    await backend.resetKeychain();
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([
      { args: ["keychain", simulatorUdid, "reset"], timeoutMs: undefined },
    ]);
  });

  test("simulator reset propagates the original transport failure", async () => {
    const simctl = new FakeSimCtlClient();
    const error = new Error("Invalid device state");
    simctl.setCommandArgsError(["keychain", simulatorUdid, "reset"], error);
    const backend = resolveIosKeychainControlBackend({ deviceId: simulatorUdid, simctl });

    await expect(backend.resetKeychain()).rejects.toBe(error);
  });

  test.each([physicalUdid, "unrecognized-device"])(
    "physical reset rejects %s without calling simctl",
    async (deviceId) => {
      const simctl = new FakeSimCtlClient();
      const backend = resolveIosKeychainControlBackend({ deviceId, simctl });

      expect(backend.kind).toBe("physical");
      await expect(backend.resetKeychain()).rejects.toThrow(
        "Keychain reset is not supported on physical iOS devices",
      );
      expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
    },
  );
});
