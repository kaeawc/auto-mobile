import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { z } from "zod/v4";
import { DaemonState } from "../../src/daemon/daemonState";
import { runAsBindingReconciler } from "../../src/daemon/sessionBroker/provisioning/exclusion";
import { computeBindingScopeKey } from "../../src/daemon/sessionBroker/registry/bindingRegistry";
import { SESSION_BROKER_SCOPE } from "../../src/daemon/sessionBroker/hostConfig";
import { SessionManager } from "../../src/daemon/sessionManager";
import {
  assertSessionBrokerToolCall,
  type SessionBrokerToolGateState,
} from "../../src/server/sessionBrokerToolGate";
import { ToolRegistryClass } from "../../src/server/toolRegistry";
import { FakeDeviceSessionPersistence } from "../fakes/FakeDeviceSessionPersistence";
import { FakeTimer } from "../fakes/FakeTimer";

describe("session broker tool admission", () => {
  let sessions: SessionManager;
  let active: Set<string>;
  let state: SessionBrokerToolGateState;

  beforeEach(async () => {
    sessions = new SessionManager(new FakeTimer(), new FakeDeviceSessionPersistence());
    sessions.stopCleanupTimer();
    await sessions.createSession("granted", "device-a", "ios");
    await sessions.createSession("generic", "device-b", "ios");
    active = new Set(["granted"]);
    state = {
      isSessionBrokerMode: () => true,
      isInitialized: () => true,
      getSessionManager: () => sessions,
      getSessionBrokerService: () => ({
        broker: { hasActiveSession: async (id) => active.has(id) },
      }),
    };
  });

  afterEach(() => {
    sessions.stopCleanupTimer();
    DaemonState.getInstance().reset();
  });

  test("inventory stays available but every device call needs a granted live session", async () => {
    await assertSessionBrokerToolCall("listDevices", false, {}, state);
    await assertSessionBrokerToolCall("tapOn", true, { sessionUuid: "granted" }, state);
    for (const args of [
      {},
      { sessionUuid: "generic" },
      { sessionUuid: "unknown" },
      { deviceId: "device-a" },
    ]) {
      await expect(assertSessionBrokerToolCall("tapOn", true, args, state)).rejects.toThrow(
        "requires a live session",
      );
    }
    // A read tool without a session must not use implicit allocation either.
    await expect(assertSessionBrokerToolCall("observe", true, {}, state)).rejects.toThrow(
      "requires a live session",
    );
  });

  test("releasing or terminal receipts immediately remove tool access", async () => {
    active.delete("granted");
    await expect(
      assertSessionBrokerToolCall("tapOn", true, { sessionUuid: "granted" }, state),
    ).rejects.toThrow("requires a live session");
  });

  test("legacy lifecycle tools remain refused even to a valid session", async () => {
    for (const tool of [
      "getApple",
      "getAndroid",
      "provisionDevice",
      "startDevice",
      "killDevice",
      "deleteDevice",
    ]) {
      await expect(
        assertSessionBrokerToolCall(tool, false, { sessionUuid: "granted" }, state),
      ).rejects.toThrow("owns device lifecycle");
    }
    await expect(assertSessionBrokerToolCall("setActiveDevice", false, {}, state)).rejects.toThrow(
      "requires a live session",
    );
  });

  test("only the provider's private async scope may provision; caller arguments cannot grant it", async () => {
    await runAsBindingReconciler(
      { scopeKey: computeBindingScopeKey(SESSION_BROKER_SCOPE), bindingIndex: 1 },
      () => assertSessionBrokerToolCall("provisionDevice", false, {}, state),
    );
    await expect(
      runAsBindingReconciler({ scopeKey: "legacy-scope", bindingIndex: 1 }, () =>
        assertSessionBrokerToolCall("provisionDevice", false, {}, state),
      ),
    ).rejects.toThrow("owns device lifecycle");
    await expect(
      assertSessionBrokerToolCall(
        "provisionDevice",
        false,
        { scopeKey: computeBindingScopeKey(SESSION_BROKER_SCOPE) },
        state,
      ),
    ).rejects.toThrow("owns device lifecycle");
  });

  test("direct and internal tool dispatch both refuse generic allocation before invoking handlers", async () => {
    DaemonState.getInstance().setSessionBrokerMode(true);
    const registry = new ToolRegistryClass();
    let calls = 0;
    registry.register("getApple", "probe", z.object({}), async () => {
      calls += 1;
    });
    registry.registerDeviceAware("tapOn", "probe", z.object({}), async () => {
      calls += 1;
    });
    await expect(registry.getTool("getApple")!.handler({})).rejects.toThrow(
      "owns device lifecycle",
    );
    await expect(registry.callInternal("getApple", {})).rejects.toThrow("owns device lifecycle");
    await expect(registry.getTool("tapOn")!.handler({})).rejects.toThrow("requires a live session");
    await expect(
      registry.callInternal("tapOn", {}, undefined, undefined, {
        targetDevice: { platform: "ios", deviceId: "bypass", name: "bypass" },
      }),
    ).rejects.toThrow("requires a live session");
    expect(calls).toBe(0);
  });

  test("ordinary mode preserves generic allocation", async () => {
    const registry = new ToolRegistryClass();
    let calls = 0;
    registry.register("getApple", "probe", z.object({}), async () => {
      calls += 1;
    });
    await registry.getTool("getApple")!.handler({});
    expect(calls).toBe(1);
  });
});
