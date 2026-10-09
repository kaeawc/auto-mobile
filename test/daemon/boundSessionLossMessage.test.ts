import { describe, expect, test } from "bun:test";
import {
  BOUND_SESSION_LOSS_CODE,
  boundSessionLossMessage,
  releasedSessionNotFoundFields,
  sanitizeBoundSessionLoss,
} from "../../src/daemon/types";

function loss(reason: string) {
  return { code: BOUND_SESSION_LOSS_CODE, sessionUuid: "s-1", reason } as const;
}

describe("boundSessionLossMessage (#10661)", () => {
  test.each(["lazy-expiry", "cleanup-expired", "cli-idle-timeout"])(
    "%s explains the idle release, that sleep counts, and the next step",
    (reason) => {
      const message = boundSessionLossMessage(loss(reason));

      expect(message).toContain(`(${reason})`);
      expect(message).toContain("idle");
      expect(message).toContain("asleep counts");
      expect(message).toContain("Acquire a new device session");
    },
  );

  test("a heartbeat timeout blames the lapsed heartbeats, not idleness or host sleep (#10699)", () => {
    const message = boundSessionLossMessage(loss("heartbeat-timeout"));

    expect(message).toContain("(heartbeat-timeout)");
    expect(message).toContain("stopped receiving this session's liveness heartbeats");
    expect(message).not.toContain("idle");
    expect(message).not.toContain("asleep");
    expect(message).toContain("Acquire a new device session");
  });

  test("an owner disconnect says the owning connection closed (#10730)", () => {
    const message = boundSessionLossMessage(loss("owner-disconnected"));

    expect(message).toContain("(owner-disconnected)");
    expect(message).toContain("connection that owned this session closed");
    expect(message).not.toContain("idle");
  });

  test.each(["daemon-shutdown", "device-restart:Pixel_8"])(
    "%s says the daemon or device restarted (#10730)",
    (reason) => {
      expect(boundSessionLossMessage(loss(reason))).toContain("shut down or restarted");
    },
  );

  test("other reasons keep the plain wording", () => {
    expect(boundSessionLossMessage(loss("explicit-release"))).toBe(
      "Device session s-1 is no longer active (explicit-release). " +
        "Acquire a new device session before continuing.",
    );
  });
});

describe("releasedSessionNotFoundFields (#10832)", () => {
  test.each(["lazy-expiry", "cleanup-expired", "cli-idle-timeout"])(
    "%s is flagged as an idle release",
    (reason) => {
      expect(releasedSessionNotFoundFields(reason)).toEqual({ releaseReason: reason, idle: true });
    },
  );

  test.each(["heartbeat-timeout", "explicit-release", "owner-disconnected", "daemon-shutdown"])(
    "%s carries its reason without the idle flag",
    (reason) => {
      expect(releasedSessionNotFoundFields(reason)).toEqual({ releaseReason: reason });
    },
  );

  test("a never-issued session adds nothing", () => {
    expect(releasedSessionNotFoundFields(undefined)).toEqual({});
  });
});

describe("sanitizeBoundSessionLoss release.ownerPid (#11098)", () => {
  const release = (extra: Record<string, unknown>) => ({
    ...loss("identity-recovery-owned-by-other-daemon"),
    release: {
      sessionId: "s-1",
      deviceId: "emulator-5554",
      releaseReason: "identity-recovery-owned-by-other-daemon",
      releasedAtMs: 2,
      terminal: true,
      heartbeat: { lastHeartbeatMs: 1, hasReceivedHeartbeat: true, timeoutMs: 20_000, ageMs: 1 },
      ...extra,
    },
  });

  test("keeps an integer ownerPid", () => {
    expect(sanitizeBoundSessionLoss(release({ ownerPid: 4242 }))?.release?.ownerPid).toBe(4242);
  });

  test("drops a non-integer ownerPid and omits it when absent", () => {
    expect(sanitizeBoundSessionLoss(release({ ownerPid: "4242" }))?.release).not.toHaveProperty(
      "ownerPid",
    );
    expect(sanitizeBoundSessionLoss(release({}))?.release).not.toHaveProperty("ownerPid");
  });
});
