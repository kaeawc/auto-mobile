import { afterEach, describe, expect, test } from "bun:test";
import { defaultDaemonContext, type DaemonContext } from "../../src/daemon/daemonContext";
import { DaemonState } from "../../src/daemon/daemonState";
import { withAdmittedSessionEcho } from "../../src/server/routedSessionEcho";
import { sessionRenderedObservation } from "../../src/features/action/TargetDisplayAction";
import { sessionRenderedDisplayGeneration } from "../../src/features/action/BaseVisualChange";

function contextWith(reads: ReturnType<DaemonContext["renderedDisplaySessions"]>): DaemonContext {
  return { renderedDisplaySessions: () => reads, sessionManager: () => undefined };
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
      getSessionForDevice: (deviceId) => (deviceId === "d1" ? "s1" : undefined),
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

  test("injected context feeds the admitted-session echo without DaemonState", () => {
    DaemonState.getInstance().reset();
    const ctx: DaemonContext = { ...contextWith(undefined), sessionManager: () => undefined };
    const result = { content: [] };
    expect(withAdmittedSessionEcho(result, "no-such-execution", ctx)).toBeDefined();
  });
});
