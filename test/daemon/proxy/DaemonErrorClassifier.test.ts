import { describe, expect, test } from "bun:test";
import { DaemonRequestNotDeliveredError } from "../../../src/daemon/DaemonRequestNotDeliveredError";
import { DaemonShuttingDownError } from "../../../src/daemon/DaemonShuttingDownError";
import { DaemonErrorClassifier } from "../../../src/daemon/proxy/DaemonErrorClassifier";
import { DaemonUnavailableError } from "../../../src/daemon/client/client";
import { DaemonVersionMismatchError } from "../../../src/daemon/proxy/DaemonVersionMismatchError";
import { DAEMON_SESSION_NOT_FOUND_CODE } from "../../../src/daemon/types";
import { DaemonRestartOptionsUnknownError } from "../../../src/daemon/proxy/DaemonRestartOptionsUnknownError";

function classifier(
  facts: { structuredSessionNotFound?: boolean; registered?: string[] } = {},
): DaemonErrorClassifier {
  return new DaemonErrorClassifier({
    structuredSessionNotFound: () => facts.structuredSessionNotFound ?? false,
    structuredToolErrorCodes: () => false,
    frontendRegistersTool: (name) => (facts.registered ?? []).includes(name),
  });
}

describe("DaemonErrorClassifier", () => {
  test("unknown private restart options require the original launcher, not a reconnect", () => {
    const error = new DaemonRestartOptionsUnknownError();
    expect(classifier().isRecoverableDaemonSessionError(error)).toBe(false);
    expect(classifier().isRecoverableDaemonSessionError(error, false)).toBe(false);
  });
  test("a structured not-found code is session loss on any daemon", () => {
    const error = Object.assign(new Error("gone"), { code: DAEMON_SESSION_NOT_FOUND_CODE });
    expect(
      classifier({ structuredSessionNotFound: true }).isDaemonSessionNotFoundError(error),
    ).toBe(true);
  });

  test("bare Session not found prose counts only for daemons without structured codes", () => {
    const error = new Error("Session not found: abc");
    expect(classifier().isDaemonSessionNotFoundError(error)).toBe(true);
    expect(
      classifier({ structuredSessionNotFound: true }).isDaemonSessionNotFoundError(error),
    ).toBe(false);
  });

  test("an unknown tool is recoverable only when the frontend registers it", () => {
    const error = new Error("Unknown tool: observe");
    expect(classifier({ registered: ["observe"] }).isRecoverableUnknownToolError(error)).toBe(true);
    expect(classifier({ registered: ["tapOn"] }).isRecoverableUnknownToolError(error)).toBe(false);
  });

  test("never-written and pre-admission rejections are provably undispatched", () => {
    const c = classifier();
    expect(c.isProvablyUndispatchedError(new DaemonRequestNotDeliveredError("x"))).toBe(true);
    expect(c.isProvablyUndispatchedError(new Error("socket reset"))).toBe(false);
    expect(c.isProvablyUndispatchedError(new DaemonShuttingDownError(true))).toBe(false);
    expect(c.isProvablyUndispatchedError(new DaemonShuttingDownError(false))).toBe(true);
  });

  test("compatibility mismatches are not healed by reconnecting; unavailable is", () => {
    const c = classifier();
    expect(c.isRecoverableDaemonSessionError(new DaemonUnavailableError("down"))).toBe(true);
    expect(
      c.isRecoverableDaemonSessionError(
        new DaemonVersionMismatchError({
          clientVersion: "1.0.0",
          daemonVersion: "2.0.0",
          reason: "daemonNewer",
          detail: "skew",
        }),
      ),
    ).toBe(false);
    expect(c.isRecoverableDaemonSessionError(new Error("boom"), false)).toBe(false);
  });
});
