import { describe, expect, test } from "bun:test";
import {
  SessionScopedStreamAuthenticator,
  STREAM_SOCKET_AUTH_ENV,
  type StreamAuthSessionManager,
} from "../../src/daemon/streamSocketAuth";
import { releasingSessionHarness } from "../helpers/releasingSessionHarness";
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

  test("strict re-authorization requires ownership by the base session", () => {
    let owner: string | null = null;
    const sm = sessionManager({
      getSessionForDevice: () => owner,
      getDeviceLabels: (uuid) => (uuid === "live" ? { phone: "live:phone" } : undefined),
    });
    const auth = authenticator(sm);
    expect(() => auth.authorize({ sessionUuid: "live", deviceId: "emu" })).not.toThrow();
    expect(() =>
      auth.authorize({ sessionUuid: "live", deviceId: "emu", requireOwnership: true }),
    ).toThrow(/no longer owned/);
    owner = "live";
    expect(() =>
      auth.authorize({ sessionUuid: "live", deviceId: "emu", requireOwnership: true }),
    ).not.toThrow();
    expect(() =>
      auth.authorize({ sessionUuid: "live:phone", deviceId: "emu", requireOwnership: true }),
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

describe("stream release evidence", () => {
  function notAdmittedManager(releasing: "none" | "same" | "different" = "none") {
    const live = {};
    const stale = {};
    return {
      ...sessionManager(),
      getSession: (id: string) => (id === "live" ? live : null),
      isAdmittedForAutomation: () => false,
      getReleasingSession: () =>
        releasing === "same" ? live : releasing === "different" ? stale : null,
    };
  }

  test("live unregistered session preserves the different-owner device error", () => {
    const sm = { ...notAdmittedManager(), getSessionForDevice: () => "other" };
    expect(() => authenticator(sm).authorize({ sessionUuid: "live", deviceId: "emu" })).toThrow(
      /bound to a different daemon session/,
    );
  });

  test("unregistered non-admitted session may stream an unowned device", () => {
    expect(() =>
      authenticator(notAdmittedManager()).authorize({ sessionUuid: "live", deviceId: "emu" }),
    ).not.toThrow();
  });

  test("terminal-fenced session without an in-flight release is not rejected as releasing", async () => {
    const h = releasingSessionHarness();
    try {
      const session = await h.create();
      h.holdTerminalFence(session);
      h.manager.getSession = (id) => (id === session.sessionId ? session : null);
      expect(() =>
        authenticator(h.manager).authorize({
          sessionUuid: session.sessionId,
          deviceId: session.assignedDevice,
        }),
      ).not.toThrow();
    } finally {
      h.dispose();
    }
  });

  test("in-flight release of the same object is rejected as being released", () => {
    expect(() =>
      authenticator(notAdmittedManager("same")).authorize({ sessionUuid: "live" }),
    ).toThrow(/being released/);
  });

  test("unknown session keeps the unknown or expired error", () => {
    expect(() =>
      authenticator(notAdmittedManager("same")).authorize({ sessionUuid: "unknown" }),
    ).toThrow(/unknown or expired/);
  });

  test("stale in-flight release of another object does not reject the live session", () => {
    expect(() =>
      authenticator(notAdmittedManager("different")).authorize({
        sessionUuid: "live",
        deviceId: "emu",
      }),
    ).not.toThrow();
  });

  test("real manager with integration getSession override preserves device mismatch error", () => {
    const h = releasingSessionHarness();
    try {
      // Exactly the unregistered-object lookup used by daemonStreamWiring.integration.test.ts.
      Object.defineProperty(h.manager, "getSession", {
        value: (id: string) => (id === "caller-session" ? {} : null),
      });
      h.manager.getSessionForDevice = () => "other-session";
      expect(() =>
        authenticator(h.manager).authorize({
          sessionUuid: "caller-session",
          deviceId: "emulator-5556",
        }),
      ).toThrow(/bound to a different daemon session/);
    } finally {
      h.dispose();
    }
  });
});
