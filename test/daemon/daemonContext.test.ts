import { afterEach, describe, expect, test } from "bun:test";
import { defaultDaemonContext, type DaemonContext } from "../../src/daemon/daemonContext";
import { SessionManager } from "../../src/daemon/sessionManager";
import { DaemonState } from "../../src/daemon/daemonState";
import { withAdmittedSessionEcho } from "../../src/server/routedSessionEcho";
import { sessionRenderedObservation } from "../../src/features/action/TargetDisplayAction";
import { getDeviceLabelMap, planLifecycleSessionUuid } from "../../src/server/deviceLabelMapping";
import { resolveAppearanceSessionKey } from "../../src/daemon/appearanceSessionKey";
import { sessionRenderedDisplayGeneration } from "../../src/features/action/BaseVisualChange";

function contextWith(reads: ReturnType<DaemonContext["renderedDisplaySessions"]>): DaemonContext {
  return {
    renderedDisplaySessions: () => reads,
    sessionManager: () => undefined,
    requireSessionManager: () => {
      throw new Error("DaemonState not initialized");
    },
    requireFullDevicePool: () => {
      throw new Error("DaemonState not initialized");
    },
    requireDeviceSessionRegistry: () => {
      throw new Error("DaemonState not initialized");
    },
    requireDevicePoolWrites: () => {
      throw new Error("DaemonState not initialized");
    },
    daemonState: () => DaemonState.getInstance(),
    isSessionBrokerMode: () => false,
    sessionBrokerService: () => undefined,
    isInitialized: () => false,
    fullDevicePool: () => undefined,
    devicePool: () => undefined,
    devicePoolWrites: () => undefined,
    brokerConnectionScopes: () => undefined,
    observerSessionRegistry: () => undefined,
    deviceSessionRegistry: () => undefined,
  };
}

describe("DaemonContext", () => {
  afterEach(() => DaemonState.getInstance().reset());

  test("default context is undefined while DaemonState is uninitialized", () => {
    DaemonState.getInstance().reset();
    expect(defaultDaemonContext.renderedDisplaySessions()).toBeUndefined();
    expect(sessionRenderedObservation("emulator-5554")).toBeUndefined();
    expect(sessionRenderedDisplayGeneration("emulator-5554")).toBeUndefined();
  });

  test("injected context feeds rendered-display reads without DaemonState", () => {
    const ctx = contextWith({
      getSessionForDevice: (deviceId) => (deviceId === "d1" ? "s1" : null),
      getLastRenderedDisplayKey: () => "panel-a",
      getLastRenderedDisplayGeneration: () => 3,
      getLastRenderedDisplayRevision: () => 7,
    });
    expect(sessionRenderedObservation("d1", ctx)).toEqual({
      display: { key: "panel-a", generation: 3 },
      displayRevision: 7,
    });
    expect(sessionRenderedObservation("other", ctx)).toBeUndefined();
    expect(sessionRenderedDisplayGeneration("d1", ctx)).toBe(3);
  });

  test("sessionManager is undefined while DaemonState is uninitialized", () => {
    DaemonState.getInstance().reset();
    expect(defaultDaemonContext.sessionManager()).toBeUndefined();
  });

  test("devicePool is undefined while DaemonState is uninitialized", () => {
    DaemonState.getInstance().reset();
    expect(defaultDaemonContext.devicePool()).toBeUndefined();
  });

  test("injected context feeds the admitted-session echo without DaemonState", () => {
    DaemonState.getInstance().reset();
    const ctx: DaemonContext = { ...contextWith(undefined), sessionManager: () => undefined };
    const result = { content: [] };
    expect(withAdmittedSessionEcho(result, "no-such-execution", ctx)).toBeDefined();
  });

  test("injected sessionManager feeds label and appearance reads without DaemonState", () => {
    const manager: SessionManager = Object.assign(Object.create(SessionManager.prototype), {
      getDeviceLabels: () => ({ a: "base" }),
      getBaseSessionOfDerivedLabel: (uuid: string) => (uuid === "base:b" ? "base" : undefined),
    });
    const ctx: DaemonContext = { ...contextWith(undefined), sessionManager: () => manager };
    expect(getDeviceLabelMap("base", ctx)).toEqual({ a: "base" });
    expect(planLifecycleSessionUuid("base:b", ctx)).toBe("base");
    expect(planLifecycleSessionUuid("other", ctx)).toBe("other");
    const none = contextWith(undefined);
    expect(getDeviceLabelMap("base", none)).toBeNull();
    expect(resolveAppearanceSessionKey(" s1 ", none)).toBe("s1");
  });
});
