import { afterEach } from "bun:test";
import {
  pendingWindowResolutionGeneration,
  resetObserveCacheStore,
  setObserveCacheStore,
} from "../../src/features/observe/cache/ObserveCacheRegistry";
import { DefaultDeviceWindowCacheInvalidator } from "../../src/features/observe/DeviceWindowCacheInvalidator";
import type { ObserveResult } from "../../src/models";
import { FakeDeviceWindowCacheInvalidator } from "../fakes/FakeDeviceWindowCacheInvalidator";
import { FakeObserveCacheStore } from "../fakes/FakeObserveCacheStore";
import { FakeTimer } from "../fakes/FakeTimer";
import {
  runDeviceWindowCacheInvalidatorContract,
  type DeviceWindowCacheInvalidatorContractHarness,
} from "./DeviceWindowCacheInvalidatorContract";

afterEach(() => resetObserveCacheStore());

const observation: ObserveResult = {
  updatedAt: 0,
  display: { key: "default", role: "unknown", posture: "unknown", generation: 0 },
  observationId: "contract",
  screenSize: { width: 1080, height: 2400 },
  systemInsets: { top: 0, bottom: 0, left: 0, right: 0 },
  viewHierarchy: { hierarchy: {} },
  freshness: { isFresh: true },
  settled: true,
};

function harness(
  build: (cache: FakeObserveCacheStore) => {
    invalidator: DeviceWindowCacheInvalidatorContractHarness["invalidator"];
    windowResolutionRequired: (deviceId: string) => boolean;
  },
): DeviceWindowCacheInvalidatorContractHarness {
  const cache = new FakeObserveCacheStore(new FakeTimer());
  setObserveCacheStore(cache);
  return {
    ...build(cache),
    cacheObservation: (deviceId) => cache.put(deviceId, observation),
    hasCachedObservation: async (deviceId) => (await cache.getMostRecent(deviceId)) !== undefined,
  };
}

runDeviceWindowCacheInvalidatorContract("FakeDeviceWindowCacheInvalidator", () =>
  harness((cache) => {
    const invalidator = new FakeDeviceWindowCacheInvalidator(undefined, cache);
    return {
      invalidator,
      windowResolutionRequired: (deviceId) => invalidator.isWindowResolutionRequired(deviceId),
    };
  }),
);

// No CtrlProxy client is registered for these device ids, so the default invalidator
// only touches the observe-result store and the window-resolution registry.
runDeviceWindowCacheInvalidatorContract("DefaultDeviceWindowCacheInvalidator", () =>
  harness(() => ({
    invalidator: new DefaultDeviceWindowCacheInvalidator(),
    windowResolutionRequired: (deviceId) =>
      pendingWindowResolutionGeneration(deviceId) !== undefined,
  })),
);
