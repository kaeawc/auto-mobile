import { describe, expect, it } from "bun:test";
import { DeviceSessionRegistry } from "../../src/daemon/deviceSessionRegistry";
import {
  createRegistryDeviceSessionResolver,
  nullDeviceSessionResolver,
} from "../../src/daemon/deviceSessionResolver";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";
import { FakeTimer } from "../fakes/FakeTimer";

function makeRegistry(scripted?: string[]): DeviceSessionRegistry {
  return new DeviceSessionRegistry(new FakeTimer(), new FakeIdGenerator(scripted));
}

describe("createRegistryDeviceSessionResolver", () => {
  it("resolves both directions for a live epoch", () => {
    const registry = makeRegistry(["uuid-a"]);
    registry.onDeviceConnected({ deviceId: "emulator-5554", platform: "android", incarnation: 1 });
    const resolver = createRegistryDeviceSessionResolver(registry);

    expect(resolver.resolveUuid("emulator-5554")).toBe("uuid-a");
    expect(resolver.resolveDeviceId("uuid-a")).toBe("emulator-5554");
    expect(resolver.isRoutingSuspended("emulator-5554")).toBe(false);
  });

  // The quarantine (#6863 review): the pool keeps the entry, its session and its
  // epoch intact, but nothing may ACT on or ROUTE BY the pooled identity until
  // discovery reads a name again.
  describe("while the pooled identity is quarantined", () => {
    const quarantinedResolver = (registry: DeviceSessionRegistry, quarantined: Set<string>) =>
      createRegistryDeviceSessionResolver(registry, (deviceId) => quarantined.has(deviceId));

    it("withholds the routing identity in both directions", () => {
      const registry = makeRegistry(["uuid-a"]);
      registry.onDeviceConnected({
        deviceId: "emulator-5554",
        platform: "android",
        incarnation: 1,
      });
      const resolver = quarantinedResolver(registry, new Set(["emulator-5554"]));

      expect(resolver.resolveUuid("emulator-5554")).toBeNull();
      expect(resolver.resolveDeviceId("uuid-a")).toBeNull();
      expect(resolver.isRoutingSuspended("emulator-5554")).toBe(true);
    });

    it("leaves an unrelated device routing normally", () => {
      const registry = makeRegistry(["uuid-a", "uuid-b"]);
      registry.onDeviceConnected({
        deviceId: "emulator-5554",
        platform: "android",
        incarnation: 1,
      });
      registry.onDeviceConnected({
        deviceId: "emulator-5556",
        platform: "android",
        incarnation: 1,
      });
      const resolver = quarantinedResolver(registry, new Set(["emulator-5554"]));

      expect(resolver.resolveUuid("emulator-5556")).toBe("uuid-b");
      expect(resolver.resolveDeviceId("uuid-b")).toBe("emulator-5556");
      expect(resolver.isRoutingSuspended("emulator-5556")).toBe(false);
    });

    it("restores the SAME uuid once the quarantine lifts", () => {
      const registry = makeRegistry(["uuid-a"]);
      registry.onDeviceConnected({
        deviceId: "emulator-5554",
        platform: "android",
        incarnation: 1,
      });
      const quarantined = new Set(["emulator-5554"]);
      const resolver = quarantinedResolver(registry, quarantined);
      expect(resolver.resolveUuid("emulator-5554")).toBeNull();

      quarantined.delete("emulator-5554");

      expect(resolver.resolveUuid("emulator-5554")).toBe("uuid-a");
      expect(resolver.resolveDeviceId("uuid-a")).toBe("emulator-5554");
      expect(resolver.isRoutingSuspended("emulator-5554")).toBe(false);
    });

    it("routes the replacement's uuid, never the retired one, after a reincarnation", () => {
      const registry = makeRegistry(["uuid-a", "uuid-b"]);
      registry.onDeviceConnected({
        deviceId: "emulator-5554",
        platform: "android",
        incarnation: 1,
      });
      const quarantined = new Set(["emulator-5554"]);
      const resolver = quarantinedResolver(registry, quarantined);

      // Discovery finally reads a DIFFERENT AVD name: the pool replaces the entry
      // under a fresh incarnation, retiring the old epoch and minting a new one.
      registry.onDeviceConnected({
        deviceId: "emulator-5554",
        platform: "android",
        incarnation: 2,
      });
      quarantined.delete("emulator-5554");

      expect(resolver.resolveUuid("emulator-5554")).toBe("uuid-b");
      expect(resolver.resolveDeviceId("uuid-b")).toBe("emulator-5554");
      expect(resolver.resolveDeviceId("uuid-a")).toBeNull();
    });
  });

  it("never suspends routing without a quarantine predicate", () => {
    const registry = makeRegistry(["uuid-a"]);
    registry.onDeviceConnected({ deviceId: "emulator-5554", platform: "android", incarnation: 1 });
    const resolver = createRegistryDeviceSessionResolver(registry);

    expect(resolver.isRoutingSuspended("emulator-5554")).toBe(false);
  });
});

describe("nullDeviceSessionResolver", () => {
  it("misses every lookup and suspends nothing", () => {
    expect(nullDeviceSessionResolver.resolveUuid("emulator-5554")).toBeNull();
    expect(nullDeviceSessionResolver.resolveDeviceId("uuid-a")).toBeNull();
    expect(nullDeviceSessionResolver.isRoutingSuspended("emulator-5554")).toBe(false);
  });
});
