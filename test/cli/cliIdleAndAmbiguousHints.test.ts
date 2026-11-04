import { describe, expect, test } from "bun:test";
import { cliDeviceOwnershipHint } from "../../src/cli/deviceOwnershipHint";

// #16882: the CLI said only `cli-idle-timeout` and `ambiguous_device_target`, so the caller could
// not find the variable that lengthens the window, nor the device ids it could pass.
describe("cliDeviceOwnershipHint for idle release and ambiguous targets (#16882)", () => {
  const idleLoss = {
    error: { code: "session_ownership_lost", reason: "cli-idle-timeout", idle: true },
  };

  test("a cli-idle-timeout loss names the window and the variable that lengthens it", () => {
    const hint = cliDeviceOwnershipHint(idleLoss, "observe", () => 120_000);
    expect(hint).toContain("after 2 minutes");
    expect(hint).toContain("AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS");
    expect(hint).toContain("at most 60 minutes");
    expect(hint).toContain("getAndroid");
  });

  test("reports the configured window, not the default", () => {
    expect(cliDeviceOwnershipHint(idleLoss, "observe", () => 600_000)).toContain(
      "after 10 minutes",
    );
  });

  test("other ownership-loss reasons get no idle hint", () => {
    const loss = { error: { code: "session_ownership_lost", reason: "device-killed" } };
    expect(cliDeviceOwnershipHint(loss, "observe", () => 120_000)).toBeUndefined();
  });

  test("an ambiguous target lists every candidate device id", () => {
    const hint = cliDeviceOwnershipHint(
      {
        code: "ambiguous_device_target",
        candidates: [
          { deviceId: "emulator-5554", platform: "android" },
          { deviceId: "emulator-5556", platform: "android" },
        ],
      },
      "observe",
    );
    expect(hint).toContain("--deviceId <id>");
    expect(hint).toContain("Candidates: emulator-5554 (android), emulator-5556 (android).");
  });

  test("an ambiguous target without usable candidates still names --deviceId", () => {
    const hint = cliDeviceOwnershipHint(
      { code: "ambiguous_device_target", candidates: [{ platform: "ios" }, "x"] },
      "observe",
    );
    expect(hint).toContain("--deviceId <id>");
    expect(hint).not.toContain("Candidates:");
  });
});
