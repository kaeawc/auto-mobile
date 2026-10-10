import { describe, expect, test } from "bun:test";
import {
  announceSessionRelease,
  type SessionReleaseAnnouncer,
} from "../../src/daemon/announceSessionRelease";
import type { SessionReleaseSnapshot } from "../../src/daemon/sessionManager";
import type { SessionReleaseExtras } from "../../src/server/sessionReleaseBroadcast";

const snapshot = (sessionId: string): SessionReleaseSnapshot => ({
  sessionId,
  deviceId: "emulator-5554",
  releaseReason: "daemon-shutdown",
  releasedAtMs: 1_000,
  terminal: true,
  heartbeat: { lastHeartbeatMs: 0, hasReceivedHeartbeat: true, timeoutMs: 1_000, ageMs: 1_000 },
});

class FakeAnnouncer implements SessionReleaseAnnouncer {
  readonly captured = new Map<string, string[]>();
  readonly emitted: Array<{
    sessionId: string;
    reason: string;
    recordingIds?: string[];
    upgradeOnly?: boolean;
  }> = [];
  takeRecordingIds(sessionId: string): string[] {
    const ids = this.captured.get(sessionId) ?? [];
    this.captured.delete(sessionId);
    return ids;
  }
  emit(
    sessionId: string,
    reason: string,
    _snapshot: SessionReleaseSnapshot,
    extras?: SessionReleaseExtras,
  ): void {
    this.emitted.push({
      sessionId,
      reason,
      recordingIds: extras?.recordingIds,
      ...(extras?.upgradeOnly ? { upgradeOnly: true } : {}),
    });
  }
}

describe("announceSessionRelease", () => {
  test("names the recordings the release finalizes and records a shutdown announcement", () => {
    const announcer = new FakeAnnouncer();
    announcer.captured.set("a", ["rec-1"]);
    const announced = new Set<string>();
    announceSessionRelease(
      announcer,
      { fallbacks: new Set(), announced },
      "a",
      "daemon-shutdown",
      snapshot("a"),
    );
    expect(announcer.emitted).toEqual([
      { sessionId: "a", reason: "daemon-shutdown", recordingIds: ["rec-1"] },
    ]);
    expect(announced.has("a")).toBe(true);
  });

  test("a release already covered by the shutdown fallback drops its captured ids (#11058)", () => {
    const announcer = new FakeAnnouncer();
    announcer.captured.set("a", ["rec-1"]);
    announceSessionRelease(
      announcer,
      { fallbacks: new Set(["a"]), announced: new Set() },
      "a",
      "daemon-shutdown",
      snapshot("a"),
    );
    expect(announcer.emitted).toEqual([]);

    // A later release reusing the UUID must not report the earlier release's recordings.
    announceSessionRelease(
      announcer,
      { fallbacks: null, announced: null },
      "a",
      "heartbeat-timeout",
      snapshot("a"),
    );
    expect(announcer.emitted).toEqual([
      { sessionId: "a", reason: "heartbeat-timeout", recordingIds: undefined },
    ]);
  });

  test("an upgrade-only release is announced with its marker (#11206)", () => {
    const announcer = new FakeAnnouncer();
    announceSessionRelease(
      announcer,
      { fallbacks: null, announced: null },
      "a",
      "explicit-release",
      snapshot("a"),
      { upgradeOnly: true },
    );
    expect(announcer.emitted).toEqual([
      { sessionId: "a", reason: "explicit-release", recordingIds: undefined, upgradeOnly: true },
    ]);
  });
});
