import type { ReleaseDeviceHold } from "../../src/daemon/sessionManager";

export type TimedReleaseHold = Extract<ReleaseDeviceHold, { settled: Promise<unknown> }>;

/** Narrow a release-device hold to its timed arm, failing the test when it is not one. */
export function timedHold(hold: ReleaseDeviceHold | undefined): TimedReleaseHold {
  if (!hold || !("settled" in hold)) {
    throw new Error("expected a timed release-device hold");
  }
  return hold;
}
