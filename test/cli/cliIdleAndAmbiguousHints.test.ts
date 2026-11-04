import { describe, expect, test } from "bun:test";
import { cliDeviceOwnershipHint } from "../../src/cli/deviceOwnershipHint";

// #16882: the CLI said only `cli-idle-timeout` and `ambiguous_device_target`, so the caller could
// not find the variable that lengthens the window, nor the device ids it could pass.
describe("cliDeviceOwnershipHint for idle release and ambiguous targets (#16882)", () => {
  const idleLoss = {
    error: { code: "session_ownership_lost", reason: "cli-idle-timeout", idle: true },
  };

  test("a cli-idle-timeout loss names the default window and the variable that lengthens it", () => {
    const hint = cliDeviceOwnershipHint(idleLoss, "observe");
    expect(hint).toContain("2 minutes by default");
    expect(hint).toContain("AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS");
    expect(hint).toContain("at most 60 minutes");
    expect(hint).toContain("getAndroid");
  });

  // Review on #16904: the window was fixed when the session was adopted, maybe under another
  // environment and under the daemon's cap, so the hint must not claim the current one.
  test("does not report this invocation's configured window as the session's", () => {
    const previous = process.env.AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS;
    process.env.AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS = "7200000";
    try {
      const hint = cliDeviceOwnershipHint(idleLoss, "observe");
      expect(hint).not.toContain("120 minutes");
      expect(hint).not.toContain("released after");
    } finally {
      if (previous === undefined) {
        delete process.env.AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS;
      } else {
        process.env.AUTOMOBILE_CLI_SESSION_IDLE_TIMEOUT_MS = previous;
      }
    }
  });

  test("other ownership-loss reasons get no idle hint", () => {
    const loss = { error: { code: "session_ownership_lost", reason: "device-killed" } };
    expect(cliDeviceOwnershipHint(loss, "observe")).toBeUndefined();
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
