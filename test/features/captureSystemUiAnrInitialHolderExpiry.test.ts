import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import { captureSystemUiAnrInitialHolder } from "../../src/features/deviceLifecycle/deviceLifecycleCore";
import { slotAgreementRig } from "../helpers/sessionSlotAgreementHarness";

// #12581: the ANR recovery only asks whether the device holder is still present. An expired
// holder is absent, and asking must not start that session's lazy release.

let rig: ReturnType<typeof slotAgreementRig>;
let releaseSpy: ReturnType<typeof spyOn<typeof rig.manager, "releaseSession">>;

beforeEach(async () => {
  rig = slotAgreementRig();
  await rig.manager.createSession("holder", "fake-device", "android", { timeoutMs: 1000 });
  releaseSpy = spyOn(rig.manager, "releaseSession");
});

afterEach(() => {
  releaseSpy.mockRestore();
  rig.manager.stopCleanupTimer();
  rig.timer.reset();
});

test("a live holder is returned, an expired one is absent, and nothing is released", () => {
  const input = {
    boot: { device: { deviceId: "fake-device" } },
    daemonState: { getSessionManager: () => rig.manager },
  };
  const pool = { getDevice: () => ({ sessionId: "holder" }) };
  const seen = [captureSystemUiAnrInitialHolder(input, pool)];
  rig.timer.advanceTime(1001);
  seen.push(captureSystemUiAnrInitialHolder(input, pool));
  expect(seen).toEqual(["holder", undefined]);
  expect(releaseSpy).not.toHaveBeenCalled();
});
