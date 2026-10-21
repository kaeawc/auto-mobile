import { describe, expect, test } from "bun:test";
import { DaemonRuntimeState } from "../../src/daemon/daemonRuntimeState";

describe("DaemonRuntimeState", () => {
  test("starts with every flag false and every monitor handle unset", () => {
    const state = new DaemonRuntimeState();
    expect(state.pidFileWritten).toBe(false);
    expect(state.enteredDaemonProcess).toBe(false);
    expect(state.completeIdentityPublished).toBe(false);
    expect(state.socketBindCommitted).toBe(false);
    expect(state.lastDatabaseHealthFailure).toBeUndefined();
    expect(state.healthCheck).toBeNull();
    expect(state.heartbeatMonitor).toBeNull();
    expect(state.navigationRetentionMonitor).toBeNull();
    expect(state.forwardLeaseIdleReleaser).toBeNull();
    expect(state.orphanWatchdog).toBeNull();
  });
});
