import { describe, expect, test } from "bun:test";
import {
  SessionScopedStreamAuthenticator,
  STREAM_SOCKET_AUTH_ENV,
  type StreamAuthSessionManager,
} from "../../src/daemon/streamSocketAuth";
import { ActionableError } from "../../src/models";

function sessionManager(
  overrides: Partial<StreamAuthSessionManager> = {},
): StreamAuthSessionManager {
  return {
    getSession: (sessionUuid) => (sessionUuid === "live" ? {} : null),
    getSessionForDevice: () => null,
    getDeviceLabels: () => undefined,
    ...overrides,
  };
}

function authenticator(
  sm: StreamAuthSessionManager | null,
  env: NodeJS.ProcessEnv = {} as NodeJS.ProcessEnv,
): SessionScopedStreamAuthenticator {
  return new SessionScopedStreamAuthenticator(() => sm, "test op", env);
}

describe("SessionScopedStreamAuthenticator", () => {
  test("rejects a missing sessionUuid", () => {
    expect(() => authenticator(sessionManager()).authorize({})).toThrow(ActionableError);
    expect(() => authenticator(sessionManager()).authorize({ sessionUuid: "  " })).toThrow(
      /authenticated daemon session/,
    );
  });

  test("rejects an unknown/expired session", () => {
    expect(() => authenticator(sessionManager()).authorize({ sessionUuid: "ghost" })).toThrow(
      /not an active daemon session/,
    );
  });

  test("accepts a live session with no device", () => {
    expect(() => authenticator(sessionManager()).authorize({ sessionUuid: "live" })).not.toThrow();
  });

  test("fails closed when the session registry is unavailable", () => {
    expect(() => authenticator(null).authorize({ sessionUuid: "live" })).toThrow(
      /session registry is unavailable/,
    );
  });

  test("permits a device that is unowned", () => {
    expect(() =>
      authenticator(sessionManager()).authorize({ sessionUuid: "live", deviceId: "emu" }),
    ).not.toThrow();
  });

  test("permits a device owned by the same session", () => {
    const sm = sessionManager({ getSessionForDevice: () => "live" });
    expect(() =>
      authenticator(sm).authorize({ sessionUuid: "live", deviceId: "emu" }),
    ).not.toThrow();
  });

  test("rejects a device owned by a different session", () => {
    const sm = sessionManager({ getSessionForDevice: () => "other" });
    expect(() => authenticator(sm).authorize({ sessionUuid: "live", deviceId: "emu" })).toThrow(
      /different daemon session/,
    );
  });

  test("resolves a derived device-label session to its base for the registry check", () => {
    const sm = sessionManager({
      getSession: (sessionUuid) => (sessionUuid === "live" ? {} : null),
      getDeviceLabels: (sessionUuid) =>
        sessionUuid === "live" ? { phone: "live:phone" } : undefined,
    });
    expect(() => authenticator(sm).authorize({ sessionUuid: "live:phone" })).not.toThrow();
  });

  test("the escape hatch disables enforcement entirely", () => {
    const env = { [STREAM_SOCKET_AUTH_ENV]: "0" } as unknown as NodeJS.ProcessEnv;
    expect(() => authenticator(sessionManager(), env).authorize({})).not.toThrow();
  });
});
