import { describe, expect, test } from "bun:test";
import { BOUND_SESSION_LOSS_CODE, boundSessionLossMessage } from "../../src/daemon/types";

function loss(reason: string) {
  return { code: BOUND_SESSION_LOSS_CODE, sessionUuid: "s-1", reason } as const;
}

describe("boundSessionLossMessage (#10661)", () => {
  test.each(["lazy-expiry", "cleanup-expired", "heartbeat-timeout", "cli-idle-timeout"])(
    "%s explains the idle release, that sleep counts, and the next step",
    (reason) => {
      const message = boundSessionLossMessage(loss(reason));

      expect(message).toContain(`(${reason})`);
      expect(message).toContain("idle");
      expect(message).toContain("asleep counts");
      expect(message).toContain("Acquire a new device session");
    },
  );

  test("other reasons keep the plain wording", () => {
    expect(boundSessionLossMessage(loss("daemon-shutdown"))).toBe(
      "Device session s-1 is no longer active (daemon-shutdown). " +
        "Acquire a new device session before continuing.",
    );
  });
});
