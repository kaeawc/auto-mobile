import { describe, expect, test } from "bun:test";
import {
  resolveIosColdAppCheckKind,
  resolveIosDeviceKind,
} from "../../../src/utils/ios-cmdline-tools/IosDeviceKind";
import { SimulatorTccSqliteClient } from "../../../src/utils/ios-cmdline-tools/SimulatorTccSqliteClient";
import { FakeTimer } from "../../fakes/FakeTimer";

const simulatorUdid = "A1B2C3D4-E5F6-7890-ABCD-EF1234567890";

describe("IosDeviceKind", () => {
  test.each([
    [simulatorUdid, "simulator"],
    [simulatorUdid.toLowerCase(), "simulator"],
    ["00008030-001C2D3E1234567A", "physical"],
    ["00008030-001c2d3e1234567a", "physical"],
    ["a".repeat(40), "physical"],
    ["unrecognized-device", undefined],
    ["booted", undefined],
    ["emulator-5554", undefined],
    ["", undefined],
    [` ${simulatorUdid}`, undefined],
    ["G1B2C3D4-E5F6-7890-ABCD-EF1234567890", undefined],
  ] as const)("resolves cold app-check kind for %s", (deviceId, kind) => {
    expect(resolveIosColdAppCheckKind({ deviceId })).toBe(kind);
  });

  test.each([
    [simulatorUdid, "simulator"],
    [simulatorUdid.toLowerCase(), "simulator"],
    ["00008030-001C2D3E1234567A", "physical"],
    ["a".repeat(40), "physical"],
    ["unknown-device", "physical"],
    ["booted", "physical"],
    ["emulator-5554", "physical"],
    ["", "physical"],
    [` ${simulatorUdid}`, "physical"],
    ["G1B2C3D4-E5F6-7890-ABCD-EF1234567890", "physical"],
  ])("preserves historical backend kind for %s", (deviceId, kind) => {
    expect(resolveIosDeviceKind({ deviceId })).toBe(kind);
  });

  test("TCC validation uses injected kind before accessing the filesystem or transport", async () => {
    const deviceIds: string[] = [];
    const client = new SimulatorTccSqliteClient({
      resolveKind: ({ deviceId }) => {
        deviceIds.push(deviceId);
        return "physical";
      },
      fileSystem: {
        stat: async () => {
          throw new Error("unexpected filesystem access");
        },
      },
      executor: {
        executeCommand: async () => {
          throw new Error("unexpected transport access");
        },
      },
      deviceSetRoot: "/unused-device-set",
      timer: new FakeTimer(),
    });

    await expect(client.readPermissions(` ${simulatorUdid} `, "com.example.app")).rejects.toThrow(
      `Simulator TCC database lookup requires a simulator UDID, received ${simulatorUdid}`,
    );
    expect(deviceIds).toEqual([simulatorUdid]);
  });
});
