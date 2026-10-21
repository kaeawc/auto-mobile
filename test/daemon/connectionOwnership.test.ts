import { describe, expect, test } from "bun:test";
import {
  ConnectionOwnership,
  type ConnectionOwnershipPort,
} from "../../src/daemon/connectionOwnership";
import type { PooledDevice } from "../../src/daemon/devicePool";
import type { ForeignDeviceOwnership } from "../../src/daemon/foreignDeviceOwnership";
import type { Platform } from "../../src/models";

class FakeForeignDeviceOwnership implements ForeignDeviceOwnership {
  readonly claims: string[] = [];
  readonly releases: string[] = [];
  claimResult = true;
  pendingClaim: Promise<boolean> | undefined;
  onRelease: ((deviceId: string) => void) | undefined;

  async refresh(): Promise<void> {}

  foreignOwnerPid(): number | undefined {
    return undefined;
  }

  claim(deviceId: string): Promise<boolean> {
    this.claims.push(deviceId);
    return this.pendingClaim ?? Promise.resolve(this.claimResult);
  }

  release(deviceId: string): void {
    this.releases.push(deviceId);
    this.onRelease?.(deviceId);
  }
}

class FakeConnectionOwnershipPort implements ConnectionOwnershipPort {
  readonly devices = new Map<string, Pick<PooledDevice, "platform" | "sessionId">>();
  readonly ownership = new Map<Platform, ForeignDeviceOwnership>();
  readonly reads: string[] = [];

  foreignOwnershipFor(platform: Platform | undefined): ForeignDeviceOwnership | undefined {
    this.reads.push(`foreignOwnershipFor:${platform}`);
    return platform === undefined ? undefined : this.ownership.get(platform);
  }

  getDevice(deviceId: string): Pick<PooledDevice, "platform" | "sessionId"> | undefined {
    this.reads.push(`getDevice:${deviceId}`);
    return this.devices.get(deviceId);
  }
}

describe("ConnectionOwnership", () => {
  test("construction defers all port reads", () => {
    const port = new FakeConnectionOwnershipPort();
    const claims = new ConnectionOwnership(port);

    expect(port.reads).toEqual([]);
    expect(claims.hasClaim("device")).toBe(false);
  });

  test("publish returns true without ownership, including a missing device", async () => {
    const port = new FakeConnectionOwnershipPort();
    const claims = new ConnectionOwnership(port);
    port.devices.set("device", { platform: "android", sessionId: "session" });

    expect(await claims.publishDeviceClaim("device")).toBe(true);
    expect(await claims.publishDeviceClaim("missing")).toBe(true);
    expect(claims.hasClaim("device")).toBe(false);
    expect(claims.hasClaim("missing")).toBe(false);
    expect(port.reads).toEqual([
      "getDevice:device",
      "foreignOwnershipFor:android",
      "getDevice:missing",
      "foreignOwnershipFor:undefined",
    ]);
  });

  test("a refused claim returns false and records nothing", async () => {
    const port = new FakeConnectionOwnershipPort();
    const ownership = new FakeForeignDeviceOwnership();
    ownership.claimResult = false;
    port.ownership.set("android", ownership);
    port.devices.set("device", { platform: "android", sessionId: "session" });
    const claims = new ConnectionOwnership(port);

    expect(await claims.publishDeviceClaim("device")).toBe(false);
    expect(claims.hasClaim("device")).toBe(false);
    claims.releaseAll();
    expect(ownership.claims).toEqual(["device"]);
    expect(ownership.releases).toEqual([]);
    expect(port.reads).toEqual(["getDevice:device", "foreignOwnershipFor:android"]);
  });

  test.each(["android", "ios"] as const)(
    "a successful %s claim is recorded and kept while its session holds",
    async (platform) => {
      const port = new FakeConnectionOwnershipPort();
      const ownership = new FakeForeignDeviceOwnership();
      port.ownership.set(platform, ownership);
      port.devices.set("device", { platform, sessionId: "session" });
      const claims = new ConnectionOwnership(port);

      expect(await claims.publishDeviceClaim("device")).toBe(true);
      expect(claims.hasClaim("device")).toBe(true);
      expect(ownership.claims).toEqual(["device"]);
      expect(ownership.releases).toEqual([]);
      expect(port.reads).toEqual([
        "getDevice:device",
        `foreignOwnershipFor:${platform}`,
        "getDevice:device",
      ]);
    },
  );

  test("a successful claim without a session is withdrawn once", async () => {
    const port = new FakeConnectionOwnershipPort();
    const ownership = new FakeForeignDeviceOwnership();
    port.ownership.set("android", ownership);
    port.devices.set("device", { platform: "android", sessionId: null });
    const claims = new ConnectionOwnership(port);

    expect(await claims.publishDeviceClaim("device")).toBe(true);
    expect(claims.hasClaim("device")).toBe(false);
    claims.releaseDeviceClaim("device");
    claims.releaseAll();
    expect(ownership.releases).toEqual(["device"]);
  });

  test.each(["released", "removed"] as const)(
    "the session is re-read after awaiting a claim when the device is %s",
    async (change) => {
      const port = new FakeConnectionOwnershipPort();
      const ownership = new FakeForeignDeviceOwnership();
      const gate = Promise.withResolvers<boolean>();
      ownership.pendingClaim = gate.promise;
      port.ownership.set("android", ownership);
      port.devices.set("device", { platform: "android", sessionId: "session" });
      const claims = new ConnectionOwnership(port);

      const published = claims.publishDeviceClaim("device");
      expect(claims.hasClaim("device")).toBe(false);
      expect(port.reads).toEqual(["getDevice:device", "foreignOwnershipFor:android"]);
      if (change === "removed") {
        port.devices.delete("device");
      } else {
        port.devices.set("device", { platform: "android", sessionId: null });
      }
      gate.resolve(true);

      expect(await published).toBe(true);
      expect(claims.hasClaim("device")).toBe(false);
      expect(ownership.releases).toEqual(["device"]);
      expect(port.reads).toEqual([
        "getDevice:device",
        "foreignOwnershipFor:android",
        "getDevice:device",
      ]);
    },
  );

  test("a new holder keeps the awaited claim in its original ownership store", async () => {
    const port = new FakeConnectionOwnershipPort();
    const ownership = new FakeForeignDeviceOwnership();
    const replacementOwnership = new FakeForeignDeviceOwnership();
    const gate = Promise.withResolvers<boolean>();
    ownership.pendingClaim = gate.promise;
    port.ownership.set("android", ownership);
    port.devices.set("device", { platform: "android", sessionId: "original" });
    const claims = new ConnectionOwnership(port);

    const published = claims.publishDeviceClaim("device");
    port.devices.set("device", { platform: "android", sessionId: "new-holder" });
    port.ownership.set("android", replacementOwnership);
    gate.resolve(true);

    expect(await published).toBe(true);
    expect(claims.hasClaim("device")).toBe(true);
    expect(ownership.releases).toEqual([]);
    claims.releaseDeviceClaim("device");
    expect(ownership.releases).toEqual(["device"]);
    expect(replacementOwnership.claims).toEqual([]);
    expect(replacementOwnership.releases).toEqual([]);
  });

  test("releaseAll releases each recorded claim once and empties ownership", () => {
    const claims = new ConnectionOwnership(new FakeConnectionOwnershipPort());
    const android = new FakeForeignDeviceOwnership();
    const ios = new FakeForeignDeviceOwnership();
    claims.recordClaim("android-one", android);
    claims.recordClaim("ios-one", ios);
    claims.recordClaim("android-two", android);

    claims.releaseAll();
    claims.releaseAll();

    expect(android.releases).toEqual(["android-one", "android-two"]);
    expect(ios.releases).toEqual(["ios-one"]);
    for (const deviceId of ["android-one", "ios-one", "android-two"]) {
      expect(claims.hasClaim(deviceId)).toBe(false);
    }
  });

  test("releaseAll snapshots keys before releasing and deletes before calling the store", () => {
    const claims = new ConnectionOwnership(new FakeConnectionOwnershipPort());
    const ownership = new FakeForeignDeviceOwnership();
    claims.recordClaim("original", ownership);
    ownership.onRelease = (deviceId) => {
      expect(claims.hasClaim(deviceId)).toBe(false);
      claims.recordClaim("added-during-release", ownership);
    };

    claims.releaseAll();

    expect(ownership.releases).toEqual(["original"]);
    expect(claims.hasClaim("added-during-release")).toBe(true);
  });

  test("hasClaim and recordClaim track the latest ownership store for a device", () => {
    const claims = new ConnectionOwnership(new FakeConnectionOwnershipPort());
    const original = new FakeForeignDeviceOwnership();
    const replacement = new FakeForeignDeviceOwnership();
    expect(claims.hasClaim("device")).toBe(false);

    claims.recordClaim("device", original);
    expect(claims.hasClaim("device")).toBe(true);
    claims.recordClaim("device", replacement);
    claims.releaseDeviceClaim("device");
    claims.releaseDeviceClaim("device");
    claims.releaseDeviceClaim("unknown");

    expect(claims.hasClaim("device")).toBe(false);
    expect(original.claims).toEqual([]);
    expect(original.releases).toEqual([]);
    expect(replacement.claims).toEqual([]);
    expect(replacement.releases).toEqual(["device"]);
  });
});
