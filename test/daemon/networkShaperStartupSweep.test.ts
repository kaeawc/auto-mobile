import { expect, test } from "bun:test";
import { sweepStaleNetworkShaperProfiles } from "../../src/daemon/networkShaperStartupSweep";
import { FakeIosSimulatorNetworkShaper } from "../fakes/FakeIosSimulatorNetworkShaper";

const UDID = "79F93511-21AB-4E2F-9E1D-CE8BF15800B1";
const PEER = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";
const SHAPED = { offline: true, delayMs: 0, downloadKbps: 0, uploadKbps: 0, packetLossPercent: 0 };

test("startup unshapes a simulator a stopped daemon left shaped, keeping a live peer's", async () => {
  const shaper = new FakeIosSimulatorNetworkShaper();
  await shaper.apply(UDID, SHAPED);
  await shaper.apply(PEER, SHAPED);
  shaper.liveOwners.add(PEER);

  expect(await sweepStaleNetworkShaperProfiles(shaper)).toEqual([UDID]);

  expect(await shaper.read(UDID)).toEqual({ injected: true });
  expect(shaper.profiles.get(PEER)).toEqual(SHAPED);
});

test("a failing sweep never fails startup", async () => {
  const cleared = await sweepStaleNetworkShaperProfiles({
    clearOrphaned: async () => {
      throw new Error("EACCES");
    },
  });
  expect(cleared).toEqual([]);
});
