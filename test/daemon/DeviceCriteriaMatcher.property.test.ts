import { describe, test } from "bun:test";
import fc from "fast-check";
import { DeviceInfo, Platform } from "../../src/models";
import { DeviceCriteriaMatcher } from "../../src/daemon/DeviceCriteriaMatcher";

// Property-based tests. See Backoff.property.test.ts for the pinned-seed rationale.
const RUN_OPTIONS = { seed: 1_234_567, numRuns: 300 } as const;
const matcher = new DeviceCriteriaMatcher();
const shortString = fc.string({ maxLength: 32 });
const count = fc.integer({ min: 0, max: 20 });
const platform = fc.constantFrom<Platform | undefined>(undefined, "android", "ios");

const normalize = (value: string): string | undefined => {
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed.toLowerCase() : undefined;
};

describe("DeviceCriteriaMatcher recovery policy (property-based)", () => {
  test("Android rediscovery requires the transport and accepts only matching or unresolved AVD names", () => {
    fc.assert(
      fc.property(shortString, shortString, shortString, shortString, (
        expectedDeviceId,
        expectedAvdName,
        candidateDeviceId,
        candidateAvdName
      ) => {
        const candidate = {
          deviceId: candidateDeviceId,
          name: candidateAvdName,
          platform: "android" as const,
        };
        return matcher.androidRediscoveryMatches(
          candidate,
          expectedDeviceId,
          expectedAvdName
        ) === (
          candidateDeviceId === expectedDeviceId &&
          (
            candidateAvdName === expectedAvdName ||
            candidateAvdName === `Unknown (${expectedDeviceId})`
          )
        );
      }),
      RUN_OPTIONS
    );
  });

  test("capacity includes exactly the pending recoveries eligible for the platform", () => {
    fc.assert(
      fc.property(count, count, count, platform, (
        pooledDeviceCount,
        pendingRecoveryCount,
        requiredCount,
        requestedPlatform
      ) => {
        const eligibleRecoveries = requestedPlatform === undefined || requestedPlatform === "android"
          ? pendingRecoveryCount
          : 0;
        return matcher.hasSufficientCapacityIncludingAndroidRecovery(
          pooledDeviceCount,
          requiredCount,
          pendingRecoveryCount,
          requestedPlatform
        ) === (pooledDeviceCount + eligibleRecoveries >= requiredCount);
      }),
      RUN_OPTIONS
    );
  });

  test("adding pooled devices or eligible recoveries cannot reduce capacity", () => {
    fc.assert(
      fc.property(count, count, count, count, count, platform, (
        pooledDeviceCount,
        pendingRecoveryCount,
        extraPooledDevices,
        extraRecoveries,
        requiredCount,
        requestedPlatform
      ) => {
        const before = matcher.hasSufficientCapacityIncludingAndroidRecovery(
          pooledDeviceCount,
          requiredCount,
          pendingRecoveryCount,
          requestedPlatform
        );
        const after = matcher.hasSufficientCapacityIncludingAndroidRecovery(
          pooledDeviceCount + extraPooledDevices,
          requiredCount,
          pendingRecoveryCount + extraRecoveries,
          requestedPlatform
        );
        return !before || after;
      }),
      RUN_OPTIONS
    );
  });

  test("pending-image matching is existential and honors normalized AVD names", () => {
    fc.assert(
      fc.property(fc.array(shortString, { maxLength: 20 }), shortString, (names, requestedName) => {
        const images: DeviceInfo[] = names.map(name => ({
          name,
          platform: "android",
          isRunning: false,
        }));
        const normalizedRequest = normalize(requestedName);
        const expected = images.length > 0 && (
          normalizedRequest === undefined ||
          names.some(name => normalize(name) === normalizedRequest)
        );
        return matcher.someDeviceImageMatchesCriteria(images, {
          platform: "android",
          simulatorType: requestedName,
        }) === expected;
      }),
      RUN_OPTIONS
    );
  });
});
