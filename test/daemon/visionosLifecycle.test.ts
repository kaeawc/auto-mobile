import { describe, expect, test } from "bun:test";
import { IdleDeviceReaper, type IdleDeviceReaperPoolPort } from "../../src/daemon/idleDeviceReaper";
import { ForeignClaims } from "../../src/daemon/foreignClaims";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import {
  iosDeviceAllocationClaimPath,
  tvDeviceAllocationClaimPath,
  visionDeviceAllocationClaimPath,
  visionDeviceOwnershipFileSource,
} from "../../src/daemon/foreignDeviceOwnership";
import { discoverySourceOutcome, didSourceSucceedForDevice } from "../../src/utils/discoverySource";
import { FakeTimer } from "../fakes/FakeTimer";
import { FakeDeviceUtils } from "../fakes/FakeDeviceUtils";

const device = { id: "fake-vision-udid", platform: "visionos" } as const;
const pool: IdleDeviceReaperPoolPort = {
  getDevice: () => null,
  removeDevice: async () => {},
  withAssignmentLock: async (operation) => await operation(),
};

class FakeVisionOwnership implements ForeignDeviceOwnership {
  readonly reads: string[][] = [];
  async refresh(ids: readonly string[]): Promise<void> {
    this.reads.push([...ids]);
  }
  foreignOwnerPid(): number {
    return 42;
  }
  async claim(): Promise<boolean> {
    return false;
  }
  release(): void {}
}

describe("visionOS pool lifecycle boundaries", () => {
  test("only Vision's source can establish absence, with legacy platform fallback", async () => {
    const reaper = new IdleDeviceReaper(pool, new FakeDeviceUtils());
    for (const succeeded of [false, true]) {
      const discovery = {
        devices: [],
        succeededPlatforms: new Set(["ios", "tvos"] as const),
        succeededSources: new Set(
          succeeded ? ["visionos-simulator" as const] : ["ios-simulator" as const],
        ),
      };
      const snapshot = await reaper.getIosLivenessSnapshot({ discovery });
      expect(reaper.getIdleDeviceLivenessStatus(device, snapshot)).toBe(
        succeeded ? "stale" : "unknown",
      );
      expect(didSourceSucceedForDevice(discovery, "visionos", device.id)).toBe(succeeded);
    }
    expect(
      didSourceSucceedForDevice(
        { succeededPlatforms: new Set(["visionos"]) },
        "visionos",
        device.id,
      ),
    ).toBe(true);
  });

  test("fresh Vision presence remains assignable when iOS discovery failed", async () => {
    const reaper = new IdleDeviceReaper(pool, new FakeDeviceUtils());
    const snapshot = await reaper.getIosLivenessSnapshot({
      discovery: {
        devices: [{ name: "Fake Vision", platform: "visionos", deviceId: device.id }],
        freshDeviceIds: new Set([device.id]),
        succeededPlatforms: new Set(["visionos"]),
        succeededSources: new Set(["visionos-simulator"]),
      },
    });
    expect(reaper.getIdleDeviceLivenessStatus(device, snapshot)).toBe("assignable");
    expect(snapshot.discoverySucceeded).toBe(false);
  });

  test("Vision tooling failure and absence use the same source completeness semantics as TV", () => {
    const discovery = {
      succeededPlatforms: new Set<"visionos">(),
      discoveryErrors: { visionos: { code: "unavailable" } },
    };
    expect(discoverySourceOutcome(discovery, "visionos-simulator")).toBe("not_applicable");
    expect(
      discoverySourceOutcome(
        { ...discovery, expectedSources: new Set(["visionos-simulator"]) },
        "visionos-simulator",
      ),
    ).toBe("incomplete");
  });

  test("Vision claims never resolve through the iOS or TV ownership namespace", () => {
    const timer = new FakeTimer();
    const vision = new FakeVisionOwnership();
    const ios = new FakeVisionOwnership();
    const tv = new FakeVisionOwnership();
    const claims = new ForeignClaims({
      timer,
      foreignDeviceOwnership: undefined,
      iosForeignDeviceOwnership: ios,
      tvForeignDeviceOwnership: tv,
      visionForeignDeviceOwnership: vision,
      getDevice: () => undefined,
      getDevicesByPlatform: () => [],
    });
    expect(claims.foreignOwnershipFor("visionos")).toBe(vision);
    expect(claims.foreignOwnershipFor("ios")).toBe(ios);
    expect(claims.foreignOwnershipFor("tvos")).toBe(tv);
    expect(claims.tracksForeignOwnership("visionos")).toBe(true);
    const env = { AUTOMOBILE_DATA_DIR: "/fake/data" };
    const path = visionDeviceAllocationClaimPath(device.id, env, "/fake/home");
    expect(path).toContain("vision-simulators");
    expect(path).not.toBe(iosDeviceAllocationClaimPath(device.id, env, "/fake/home"));
    expect(path).not.toBe(tvDeviceAllocationClaimPath(device.id, env, "/fake/home"));
    expect(visionDeviceOwnershipFileSource.leasePath(device.id)).toBeUndefined();
  });
});
