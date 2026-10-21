import { describe, expect, test } from "bun:test";
import { DaemonShutdownState } from "../../src/daemon/daemonShutdownState";

describe("DaemonShutdownState", () => {
  test("starts not shutting down with no release-notification sets", () => {
    const state = new DaemonShutdownState();

    expect(state.inProgress).toBe(false);
    expect(state.releaseNotifications).toBeNull();
    expect(state.fallbackReleaseNotifications).toBeNull();
  });

  test("does not share state between instances", () => {
    const first = new DaemonShutdownState();
    const second = new DaemonShutdownState();

    first.inProgress = true;
    first.releaseNotifications = new Set(["session"]);
    first.fallbackReleaseNotifications = new Set(["fallback"]);

    expect(second.inProgress).toBe(false);
    expect(second.releaseNotifications).toBeNull();
    expect(second.fallbackReleaseNotifications).toBeNull();
  });
});
