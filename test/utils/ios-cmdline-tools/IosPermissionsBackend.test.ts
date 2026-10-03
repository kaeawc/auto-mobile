import { describe, expect, test } from "bun:test";
import { FakeSimCtlClient } from "../../fakes/FakeSimCtlClient";
import {
  resolveIosPermissionsBackend,
  resolveIosPermissionsKind,
  SimulatorIosPermissionsBackend,
  PhysicalIosPermissionsBackend,
} from "../../../src/utils/ios-cmdline-tools/IosPermissionsBackend";

const simulatorUdid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";
const physicalUdid = "00008030-001C2D3E1234567A";
const appId = "com.example.app";

describe("IosPermissionsBackend", () => {
  test.each(["grant", "revoke", "reset"] as const)(
    "simulator forwards exact privacy argv and output for %s",
    async (action) => {
      const simctl = new FakeSimCtlClient();
      const args = ["privacy", simulatorUdid, action, "camera", appId];
      simctl.setCommandArgsResult(args, "privacy output", "privacy stderr");
      const backend = resolveIosPermissionsBackend({ deviceId: simulatorUdid, simctl });

      expect(backend).toBeInstanceOf(SimulatorIosPermissionsBackend);
      expect(backend.kind).toBe("simulator");
      const result = await backend.setPrivacy({ action, permission: "camera", appId });
      expect(result.stdout).toBe("privacy output");
      expect(result.stderr).toBe("privacy stderr");
      expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([{ args, timeoutMs: undefined }]);
    },
  );

  test("propagates the simulator transport error unchanged", async () => {
    const simctl = new FakeSimCtlClient();
    const error = new Error("privacy unavailable");
    simctl.setCommandArgsError(["privacy", simulatorUdid, "grant", "camera", appId], error);
    const backend = resolveIosPermissionsBackend({ deviceId: simulatorUdid, simctl });

    await expect(backend.setPrivacy({ action: "grant", permission: "camera", appId })).rejects.toBe(
      error,
    );
  });

  test("physical privacy rejects with the existing message without simctl", async () => {
    const simctl = new FakeSimCtlClient();
    const backend = resolveIosPermissionsBackend({ deviceId: physicalUdid, simctl });

    expect(backend).toBeInstanceOf(PhysicalIosPermissionsBackend);
    expect(backend.kind).toBe("physical");
    await expect(
      backend.setPrivacy({ action: "reset", permission: "camera", appId }),
    ).rejects.toThrow("iOS permission changes via simctl privacy are only supported on simulators");
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });

  test.each([
    [simulatorUdid, "simulator"],
    [simulatorUdid.toLowerCase(), "simulator"],
    [physicalUdid, "physical"],
    ["a".repeat(40), "physical"],
    ["unknown-device", "physical"],
    ["booted", "physical"],
    ["emulator-5554", "physical"],
    ["", "physical"],
    [` ${simulatorUdid}`, "physical"],
    ["G1B2C3D4-E5F6-7890-ABCD-EF1234567890", "physical"],
  ])("preserves historical kind resolution for %s", (deviceId, kind) => {
    const simctl = new FakeSimCtlClient();
    expect(resolveIosPermissionsKind({ deviceId })).toBe(kind);
    expect(resolveIosPermissionsBackend({ deviceId, simctl }).kind).toBe(kind);
    expect(simctl.getMethodCalls("executeCommandArgs")).toEqual([]);
  });
});
