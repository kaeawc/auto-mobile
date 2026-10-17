import { afterEach, beforeEach, expect, spyOn, test } from "bun:test";
import {
  type AppearanceSweepPeers,
  sweepStaleAppearanceConfigs,
} from "../../src/daemon/appearanceConfigStartupSweep";
import type { RehydrationSummary } from "../../src/daemon/sessionManager";
import { slotAgreementRig } from "../helpers/sessionSlotAgreementHarness";

// #12581: the startup appearance-row sweep only asks whether a session is present. It must treat
// an expired session as absent without starting that session's lazy release (the cleanup timer and
// the heartbeat monitor own expiry).

const NO_PEERS: AppearanceSweepPeers = {
  liveDaemonSessionIds: new Set(),
  ownDaemonSessionId: "self",
  getPersistedSession: async () => undefined,
};
const SUMMARY: RehydrationSummary = {
  rehydrated: [],
  terminalized: [],
  skipped: [],
  timedOut: false,
};

let rig: ReturnType<typeof slotAgreementRig>;
let releaseSpy: ReturnType<typeof spyOn<typeof rig.manager, "releaseSession">>;

beforeEach(async () => {
  rig = slotAgreementRig();
  await rig.manager.createSession("expiring", "fake-device", "android", { timeoutMs: 1000 });
  releaseSpy = spyOn(rig.manager, "releaseSession");
});

afterEach(() => {
  releaseSpy.mockRestore();
  rig.manager.stopCleanupTimer();
  rig.timer.reset();
});

test("a live session is present, an expired one is absent, and the sweep releases nothing", async () => {
  const seen: Array<[string, boolean]> = [];
  await sweepStaleAppearanceConfigs(SUMMARY, rig.manager, NO_PEERS, async (isLive) => {
    seen.push(["expiring", await isLive("expiring")]);
    return [];
  });
  rig.timer.advanceTime(1001);
  await sweepStaleAppearanceConfigs(SUMMARY, rig.manager, NO_PEERS, async (isLive) => {
    seen.push(["expiring", await isLive("expiring")]);
    return [];
  });
  expect(seen).toEqual([
    ["expiring", true],
    ["expiring", false],
  ]);
  expect(releaseSpy).not.toHaveBeenCalled();
});
