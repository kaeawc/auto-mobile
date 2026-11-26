import { describe, expect, test } from "bun:test";
import { DaemonBoundSessionExpiredError } from "../../../src/daemon/proxy/DaemonBoundSessionExpiredError";
import {
  DEVICE_SESSION_RECOVERY_PROMPT,
  deviceSessionRecoveryPrompt,
} from "../../../src/daemon/deviceSessionResult";
import { withLostSessionPlatform } from "../../../src/daemon/proxy/lostSessionPlatform";
import { DaemonConnectionSessionReleasedError } from "../../../src/daemon/proxy/DaemonConnectionSessionReleasedError";
import {
  noActiveDeviceSessionResult,
  sessionOwnershipLostResult,
} from "../../../src/server/proxyServer";

describe("lost-session recovery prose names a tool that can acquire the platform (#19186)", () => {
  test("Android, iOS and an unknown platform keep getAndroid or getApple", () => {
    expect(deviceSessionRecoveryPrompt()).toBe(DEVICE_SESSION_RECOVERY_PROMPT);
    expect(deviceSessionRecoveryPrompt("android")).toBe(DEVICE_SESSION_RECOVERY_PROMPT);
    expect(deviceSessionRecoveryPrompt("ios")).toBe(DEVICE_SESSION_RECOVERY_PROMPT);
  });

  test.each([
    ["watchos", "watchOS"],
    ["tvos", "tvOS"],
    ["visionos", "visionOS"],
  ] as const)("a %s session is told to call startDevice with its platform", (platform, label) => {
    const prompt = deviceSessionRecoveryPrompt(platform);
    expect(prompt).toBe(
      `Call startDevice with platform: "${platform}" to acquire a new ${label} device session.`,
    );
    expect(prompt).not.toContain("getApple");
  });

  test("forPlatform rewrites the error's prose and records the platform", () => {
    const error = new DaemonBoundSessionExpiredError("watch-session", "released");
    expect(error.message).toContain("getAndroid or getApple");

    expect(error.forPlatform("watchos")).toBe(error);
    expect(error.platform).toBe("watchos");
    expect(error.message).toBe(
      "Device session watch-session expired or was released (released) and cannot be used again. " +
        'Call startDevice with platform: "watchos" to acquire a new watchOS device session.',
    );
  });
});

describe("the proxy names a lost Apple session's platform (#19186)", () => {
  const platforms = new Map([["watch-session", "watchos" as const]]);

  test("an ownership loss of a recorded watch session names startDevice", () => {
    const error = new DaemonBoundSessionExpiredError("watch-session", "released");
    expect(withLostSessionPlatform(error, platforms)).toBe(error);
    expect(error.platform).toBe("watchos");

    const result = sessionOwnershipLostResult(error);
    const text = (result.content[0] as { text: string }).text;
    const payload = JSON.parse(text);
    expect(payload.error.code).toBe("session_ownership_lost");
    expect(payload.error.message).toBe(
      "Session ownership lost for watch-session: released. " +
        'Call startDevice with platform: "watchos" to acquire a new watchOS device session.',
    );
    expect(payload.error.recovery).toEqual({
      action: "acquire_replacement_session",
      tools: ["startDevice"],
      platform: "watchos",
    });
  });

  test("an Android or iOS loss keeps getAndroid and getApple as recovery tools", () => {
    const payload = JSON.parse(
      (
        sessionOwnershipLostResult(new DaemonBoundSessionExpiredError("phone", "released"))
          .content[0] as { text: string }
      ).text,
    );
    expect(payload.error.recovery).toEqual({
      action: "acquire_replacement_session",
      tools: ["getAndroid", "getApple"],
    });
  });

  test("an unrecorded session and other errors pass through unchanged", () => {
    const error = new DaemonBoundSessionExpiredError("phone-session", "released");
    expect(withLostSessionPlatform(error, platforms)).toBe(error);
    expect(error.platform).toBeUndefined();
    expect(error.message).toContain("getAndroid or getApple");

    const other = new Error("boom");
    expect(withLostSessionPlatform(other, platforms)).toBe(other);
  });
});

describe("no_active_device_session names a released Apple session's platform (#19234)", () => {
  const platforms = new Map([["watch-session", "watchos" as const]]);

  function payload(error: DaemonConnectionSessionReleasedError) {
    const [content] = noActiveDeviceSessionResult(error).content;
    return JSON.parse((content as { text: string }).text).error;
  }

  test("a released watch session's connection is told to call startDevice", () => {
    const error = new DaemonConnectionSessionReleasedError("device-killed", "watch-session");
    expect(withLostSessionPlatform(error, platforms)).toBe(error);
    expect(error.platform).toBe("watchos");

    const refusal = payload(error);
    expect(refusal.code).toBe("no_active_device_session");
    expect(refusal.message).toBe(
      "This MCP connection has no active device session (the previous session was released: " +
        'device-killed). Call startDevice with platform: "watchos" to acquire a new watchOS device session.',
    );
    expect(refusal.recovery).toEqual({
      action: "acquire_replacement_session",
      tools: ["startDevice"],
      platform: "watchos",
    });
  });

  test("an Android or iOS session, or an unknown one, keeps getAndroid and getApple", () => {
    for (const error of [
      new DaemonConnectionSessionReleasedError("device-killed", "phone-session"),
      new DaemonConnectionSessionReleasedError("device-killed"),
    ]) {
      expect(withLostSessionPlatform(error, platforms)).toBe(error);
      expect(error.platform).toBeUndefined();
      const refusal = payload(error);
      expect(refusal.message).toContain("Call getAndroid or getApple");
      expect(refusal.recovery).toEqual({
        action: "acquire_replacement_session",
        tools: ["getAndroid", "getApple"],
      });
    }
  });
});
