import { describe, expect, it } from "bun:test";
import { whileHoldingProvisionedSession } from "../../../src/server/provisioning/provisioningSession";

/** Records each hold and release, so a test can see what the steps ran under. */
function fakeHold() {
  const events: string[] = [];
  return {
    events,
    deps: {
      holdAcquiringSession: (sessionUuid: string, deadlineMs: number) => {
        events.push(`hold:${sessionUuid}@${deadlineMs}`);
        return () => events.push(`release:${sessionUuid}`);
      },
    },
  };
}

describe("whileHoldingProvisionedSession (#17885)", () => {
  it("runs the post-bind steps under a hold on the minted session, then releases it", async () => {
    const { events, deps } = fakeHold();
    const result = await whileHoldingProvisionedSession(
      deps,
      { sessionUuid: "minted", deadlineMs: 90_000 },
      async () => {
        events.push("androidAuto");
        return "report";
      },
    );
    expect(result).toBe("report");
    expect(events).toEqual(["hold:minted@90000", "androidAuto", "release:minted"]);
  });

  it("releases the hold before a failed step's error reaches the rollback", async () => {
    const { events, deps } = fakeHold();
    const failing = whileHoldingProvisionedSession(
      deps,
      { sessionUuid: "minted", deadlineMs: 90_000 },
      async () => {
        throw new Error("developer mode step failed");
      },
    );
    await expect(failing).rejects.toThrow("developer mode step failed");
    expect(events).toEqual(["hold:minted@90000", "release:minted"]);
  });
});
