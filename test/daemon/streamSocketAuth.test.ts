import { ObserverAdmittingStreamAuthenticator } from "../../src/daemon/streamSocketAuth";
import { ObserverSessionRegistry } from "../../src/daemon/observerSessionRegistry";
import { FakeTimer } from "../fakes/FakeTimer";
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

  test("viewer admission accepts a live non-owner but never bypasses requireOwnership", () => {
    const auth = authenticator(sessionManager({ getSessionForDevice: () => "other" }));
    const input = { sessionUuid: "live", deviceId: "emu", admitViewer: true };
    expect(() => auth.authorize(input)).not.toThrow();
    expect(() => auth.authorize({ ...input, requireOwnership: true })).toThrow(
      /different daemon session/,
    );
  });

  test.each([undefined, "ghost", "expired", "observer"])(
    "viewer admission still rejects invalid identity %s with a structured error",
    (sessionUuid) => {
      const auth = authenticator(sessionManager({ getSessionForDevice: () => "other" }));
      const attempt = () => auth.authorize({ sessionUuid, deviceId: "emu", admitViewer: true });
      expect(attempt).toThrow(ActionableError);
      expect(attempt).toThrow(sessionUuid ? /unknown or expired/ : /authenticated daemon session/);
    },
  );

  test("viewer admission rejects a releasing device session", () => {
    const session = {};
    const auth = authenticator(
      sessionManager({
        getSession: () => session,
        getReleasingSession: () => session,
        getSessionForDevice: () => "other",
      }),
    );
    expect(() =>
      auth.authorize({ sessionUuid: "live", deviceId: "emu", admitViewer: true }),
    ).toThrow(/being released/);
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

describe("structured subscription identity (additive to authorize)", () => {
  test("reports unowned, owned, differently owned and absent session without interpreting errors", () => {
    let owner: string | null = null;
    const auth = authenticator(sessionManager({ getSessionForDevice: () => owner }));
    const input = { sessionUuid: "live", deviceId: "emu" };
    expect(auth.resolveSubscriptionIdentity(input)).toEqual({
      authEnabled: true,
      sessionExists: true,
      ownsDevice: false,
      hasDeviceOwner: false,
    });
    owner = "live";
    expect(auth.resolveSubscriptionIdentity(input).ownsDevice).toBe(true);
    owner = "other";
    expect(auth.resolveSubscriptionIdentity(input)).toEqual({
      authEnabled: true,
      sessionExists: true,
      ownsDevice: false,
      hasDeviceOwner: true,
    });
    expect(() => auth.authorize(input)).toThrow(/different daemon session/);
    expect(
      auth.resolveSubscriptionIdentity({ sessionUuid: "missing", deviceId: "emu" }).sessionExists,
    ).toBe(false);
    expect(authenticator(null).resolveSubscriptionIdentity(input).sessionExists).toBe(false);
    expect(auth.resolveSubscriptionIdentity({ sessionUuid: " " }).sessionExists).toBe(false);
  });
  test("derived subscriber and derived owner use the same base identity", () => {
    const auth = authenticator(
      sessionManager({
        getSessionForDevice: () => "live:phone",
        getDeviceLabels: (id) => (id === "live" ? { phone: "live:phone" } : undefined),
      }),
    );
    expect(
      auth.resolveSubscriptionIdentity({ sessionUuid: " live:phone ", deviceId: "emu" }),
    ).toEqual({ authEnabled: true, sessionExists: true, ownsDevice: true, hasDeviceOwner: true });
  });
  test("releasing identity is not live but a stale releasing object does not fence it", () => {
    const session = {};
    let releasing: unknown = session;
    const auth = authenticator(
      sessionManager({
        getSession: () => session,
        getReleasingSession: () => releasing,
        getSessionForDevice: () => "live",
      }),
    );
    expect(auth.resolveSubscriptionIdentity({ sessionUuid: "live", deviceId: "emu" })).toEqual({
      authEnabled: true,
      sessionExists: false,
      ownsDevice: false,
      hasDeviceOwner: true,
    });
    releasing = {};
    expect(
      auth.resolveSubscriptionIdentity({ sessionUuid: "live", deviceId: "emu" }).sessionExists,
    ).toBe(true);
  });
  test("auth off does not resolve the registry and reports disabled enforcement", () => {
    const auth = new SessionScopedStreamAuthenticator(
      () => {
        throw new Error("must not resolve");
      },
      "test op",
      { [STREAM_SOCKET_AUTH_ENV]: "0" },
    );
    expect(auth.resolveSubscriptionIdentity({})).toEqual({
      authEnabled: false,
      sessionExists: false,
      ownsDevice: false,
    });
    expect(() => auth.authorize({})).not.toThrow();
  });
});

describe("observer session admission is opt-in", () => {
  test("admits observation requests but retains device scope and derived identity", () => {
    const registry = new ObserverSessionRegistry(new FakeTimer());
    registry.register("observer", "desktop");
    const manager = sessionManager({
      getDeviceLabels: (uuid) => (uuid === "observer" ? { label: "observer:label" } : undefined),
      getSessionForDevice: (id) => (id === "owned" ? "other" : null),
    });
    const auth = new ObserverAdmittingStreamAuthenticator({
      resolveSessionManager: () => manager,
      resolveObserverRegistry: () => registry,
      operation: "observationStream",
      env: {},
    });
    expect(() => auth.authorize({ sessionUuid: "observer" })).not.toThrow();
    expect(() =>
      auth.authorize({ sessionUuid: "observer:label", deviceId: "unowned" }),
    ).not.toThrow();
    expect(() => auth.authorize({ sessionUuid: "observer", deviceId: "owned" })).toThrow(
      /different daemon session/,
    );
    for (const operation of ["videoStream", "webrtcStream", "recording", "appearance", "config"]) {
      expect(() =>
        new SessionScopedStreamAuthenticator(() => manager, operation, {}).authorize({
          sessionUuid: "observer",
          deviceId: "owned",
          admitViewer: true,
        }),
      ).toThrow(/not an active daemon session/);
    }
  });
  test("the read-only viewer grant covers observers and holders alike (#10698)", () => {
    const registry = new ObserverSessionRegistry(new FakeTimer());
    registry.register("observer", "desktop");
    // "agent" holds "owned"; "live" holds "own" and nothing else; "observer" holds nothing.
    const manager = sessionManager({
      getSessionForDevice: (id) => (id === "owned" ? "agent" : id === "own" ? "live" : null),
    });
    const auth = new ObserverAdmittingStreamAuthenticator({
      resolveSessionManager: () => manager,
      resolveObserverRegistry: () => registry,
      operation: "videoStream",
      env: {},
    });
    const view = (sessionUuid: string, deviceId: string) => () =>
      auth.authorize({ sessionUuid, deviceId, admitViewer: true });

    // An observer-only session may watch a device another session owns.
    expect(view("observer", "owned")).not.toThrow();
    expect(
      auth.resolveSubscriptionIdentity({ sessionUuid: "observer", deviceId: "owned" }),
    ).toEqual({ authEnabled: true, sessionExists: true, ownsDevice: false, hasDeviceOwner: true });
    // A session holding an unrelated device gets the same read-only grant, nothing more.
    expect(view("live", "owned")).not.toThrow();
    expect(auth.resolveSubscriptionIdentity({ sessionUuid: "live", deviceId: "owned" })).toEqual({
      authEnabled: true,
      sessionExists: true,
      ownsDevice: false,
      hasDeviceOwner: true,
    });
    // The owner views its own device as its owner.
    expect(view("live", "own")).not.toThrow();
    expect(
      auth.resolveSubscriptionIdentity({ sessionUuid: "live", deviceId: "own" }),
    ).toMatchObject({ sessionExists: true, ownsDevice: true });
    // The grant is read-only: ownership rechecks and unregistered identities stay strict.
    expect(() =>
      auth.authorize({
        sessionUuid: "observer",
        deviceId: "owned",
        admitViewer: true,
        requireOwnership: true,
      }),
    ).toThrow(/different daemon session/);
    expect(view("stranger", "owned")).toThrow(/unknown or expired/);

    // An expired observer no longer counts as a live identity.
    registry.release("observer");
    expect(
      auth.resolveSubscriptionIdentity({ sessionUuid: "observer", deviceId: "owned" })
        .sessionExists,
    ).toBe(false);
  });

  test("fails closed with an unavailable observer registry", () => {
    const auth = new ObserverAdmittingStreamAuthenticator({
      resolveSessionManager: () => sessionManager(),
      resolveObserverRegistry: () => null,
      operation: "observationStream",
      env: {},
    });
    expect(() => auth.authorize({ sessionUuid: "observer" })).toThrow(/Register a session/);
  });
});
