import { describe, expect, test } from "bun:test";
import { BOUND_SESSION_LOSS_CODE, boundSessionLossMessage } from "../../src/daemon/types";

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
