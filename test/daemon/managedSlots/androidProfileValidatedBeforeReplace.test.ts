import { afterEach, describe, expect, mock, spyOn, test } from "bun:test";
import {
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
  managedSlotDeviceName,
  type ManagedSlotRequestedSpec,
  type DefaultManagedSpecResolverOptions,
  type ManagedAndroidProfileCatalog,
} from "../../../src/daemon/managedSlots/reconciler";
import { FakeIdGenerator } from "../../fakes/FakeIdGenerator";
import { FakeSlotRegistry } from "../../fakes/FakeSlotRegistry";
import { FakeTimer } from "../../fakes/FakeTimer";
import { drainUntil } from "../../helpers/fakeTimerStepping";
import { assignManagedSlotDevice } from "./managedSlotFixtures";
import {
  FakeCapacity,
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "./fixtures/reconcilerFakes";

const RUNTIME = "system-images;android-36;google_apis;x86_64";
const UNKNOWN = "this_profile_does_not_exist";
const OLD = "usable-avd";

class FakeProfileCatalog implements ManagedAndroidProfileCatalog {
  ids = ["pixel_8", "pixel_9"];
  calls: Array<AbortSignal | undefined> = [];
  read: () => Promise<string[]> = async () => this.ids;
  async listProfileIds(signal?: AbortSignal): Promise<string[]> {
    this.calls.push(signal);
    return await this.read();
  }
}

async function harness(options: DefaultManagedSpecResolverOptions = {}, emptyIos = false) {
  const timer = new FakeTimer();
  const registry = new FakeSlotRegistry(timer);
  const inventory = new FakeInventory();
  const provisioner = new FakeProvisioner(inventory);
  const deleter = new FakeDeleter(inventory);
  const profiles = new FakeProfileCatalog();
  const claims = new FakeClaims();
  const resolverOptions = { androidProfileCatalog: profiles, ...options };
  const reconciler = new ManagedSlotReconciler({
    registry,
    inventory,
    matcher: new FakeMatcher(),
    resolver: new DefaultManagedSpecResolver(undefined, resolverOptions),
    provisioner,
    deleter,
    claims,
    capacity: new FakeCapacity(),
    timer,
    idGenerator: new FakeIdGenerator(),
    isExecOwnerLive: () => false,
  });
  const key = emptyIos
    ? await emptyIosSlot(registry)
    : await assignManagedSlotDevice(registry, "android", OLD);
  if (!emptyIos) {
    inventory.devices.push({
      name: OLD,
      platform: "android",
      runtime: RUNTIME,
      deviceType: "pixel_8",
      isRunning: false,
    });
  }
  const before = await registry.getAssignment(key);
  const journal = spyOn(registry, "openSlotJournal");
  const acquire = (spec: ManagedSlotRequestedSpec, signal?: AbortSignal) =>
    reconciler.reconcile({
      key,
      platform: "android",
      role: "primary",
      requestedSpec: spec,
      deadlineMs: timer.now() + 60_000,
      signal,
    });
  const expectIntact = async () => {
    expect(deleter.calls).toEqual([]);
    expect(provisioner.calls).toEqual([]);
    expect(journal).not.toHaveBeenCalled();
    if (emptyIos) {
      expect(await registry.getAssignment(key)).toBeNull();
    } else {
      expect(await registry.getAssignment(key)).toEqual(before);
    }
    expect(inventory.has(OLD)).toBe(!emptyIos);
  };
  return {
    timer,
    registry,
    inventory,
    provisioner,
    deleter,
    profiles,
    claims,
    key,
    before,
    journal,
    acquire,
    expectIntact,
  };
}

async function emptyIosSlot(registry: FakeSlotRegistry) {
  const scope = await registry.ensureScope({
    managedHostScope: "host",
    runnerNamespace: "runner-a",
    runnerIncarnation: "boot-1",
  });
  if (scope.kind !== "ready") {
    throw new Error("scope setup failed");
  }
  const key = { scopeKey: scope.scope.scopeKey, slotIndex: 0 };
  await registry.initSlot(key, { role: "primary", platform: "ios", requestedSpec: {} });
  return key;
}

describe("Android creation profile is validated before managed-slot mutation", () => {
  afterEach(() => mock.restore());

  test("absent default profile removes the never-bound empty iOS slot", async () => {
    const h = await harness({}, true);
    h.profiles.ids = ["pixel_9"];
    expect(await h.acquire({ runtime: RUNTIME })).toMatchObject({
      outcome: "failed",
      failure: { code: "spec_unsupported", retryable: false },
      assignment: null,
    });
    expect(h.profiles.calls).toHaveLength(1);
    await h.expectIntact();
  });

  test("unreadable catalog removes the never-bound empty iOS slot", async () => {
    const h = await harness({}, true);
    h.profiles.read = async () => {
      throw new Error("catalog read failed");
    };
    expect(await h.acquire({ runtime: RUNTIME })).toMatchObject({
      outcome: "failed",
      failure: { code: "discovery_incomplete", retryable: true },
      assignment: null,
    });
    expect(h.profiles.calls).toHaveLength(1);
    await h.expectIntact();
  });

  test("incomplete Android discovery removes the never-bound empty iOS slot before catalog lookup", async () => {
    const h = await harness({}, true);
    h.inventory.complete = false;
    const listed = spyOn(h.inventory, "list");
    const result = await h.acquire({ runtime: RUNTIME });
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "discovery_incomplete", retryable: true },
      assignment: null,
      evidence: { inventoryComplete: false },
    });
    expect(listed).toHaveBeenCalledWith("android", { signal: undefined });
    expect(h.profiles.calls).toEqual([]);
    await h.expectIntact();
  });

  test("empty iOS slot adopts an Android leftover without reading an unreadable catalog", async () => {
    const h = await harness({}, true);
    const name = managedSlotDeviceName(h.key, 3, "leftover");
    h.inventory.devices.push({
      name,
      platform: "android",
      runtime: RUNTIME,
      deviceType: "pixel_8",
      isRunning: false,
    });
    h.profiles.read = async () => {
      throw new Error("catalog read failed");
    };
    expect(await h.acquire({ runtime: RUNTIME })).toMatchObject({
      outcome: "ready",
      disposition: "adopted",
      assignment: { platform: "android", stableDeviceId: name },
    });
    expect(h.profiles.calls).toEqual([]);
    expect(h.provisioner.created()).toEqual([]);
    expect(h.deleter.calls).toEqual([]);
    expect(await h.registry.getAssignment(h.key)).toMatchObject({ platform: "android" });
  });

  test("valid default profile creates on Android in an empty iOS slot", async () => {
    const h = await harness({}, true);
    expect(await h.acquire({ runtime: RUNTIME })).toMatchObject({
      outcome: "ready",
      disposition: "created",
      assignment: { platform: "android" },
      resolvedSpec: { deviceType: "pixel_8" },
    });
    expect(h.profiles.calls).toHaveLength(1);
    expect(h.provisioner.created()).toHaveLength(1);
    expect(h.provisioner.created()[0]?.platform).toBe("android");
    expect(h.deleter.calls).toEqual([]);
    expect(await h.registry.getAssignment(h.key)).toMatchObject({ platform: "android" });
  });

  test("unknown explicit profile leaves the assigned AVD and its binding intact", async () => {
    const h = await harness();
    const result = await h.acquire({ runtime: RUNTIME, deviceType: UNKNOWN });
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "spec_unsupported", retryable: false },
    });
    expect(result.failure?.message).toContain(UNKNOWN);
    expect(result.failure?.message).toContain("avdmanager list device");
    await h.expectIntact();
  });

  test("unreadable catalog safely refuses replacement", async () => {
    const h = await harness();
    h.profiles.read = async () => {
      throw new Error("catalog read failed");
    };
    const result = await h.acquire({ runtime: RUNTIME, deviceType: "pixel_9" });
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "discovery_incomplete", retryable: true },
    });
    expect(result.failure?.message).toContain("catalog read failed");
    await h.expectIntact();
  });

  test("an absent configured default refuses creation for an omitted model", async () => {
    const h = await harness({ androidDefaultDeviceType: UNKNOWN });
    await h.registry.commitBinding(
      h.key,
      { generation: 1, stableDeviceId: OLD },
      {
        stableDeviceId: null,
        deviceName: null,
        resolvedSpec: null,
        specFingerprint: null,
        state: "provisioning",
      },
    );
    h.inventory.remove(OLD);
    const result = await h.acquire({ runtime: RUNTIME });
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: "spec_unsupported", retryable: false },
    });
    expect(h.provisioner.calls).toEqual([]);
    expect(h.journal).not.toHaveBeenCalled();
  });

  test.each(["absent default", "unreadable catalog"])(
    "omitted-model reuse ignores %s",
    async (mode) => {
      const h = await harness({ androidDefaultDeviceType: UNKNOWN });
      if (mode === "unreadable catalog") {
        h.profiles.read = async () => {
          throw new Error("unreadable");
        };
      }
      const result = await h.acquire({ runtime: RUNTIME });
      expect(result).toMatchObject({
        outcome: "ready",
        disposition: "reused",
        device: { stableId: OLD },
      });
      expect(h.profiles.calls).toEqual([]);
      expect(h.deleter.calls).toEqual([]);
    },
  );

  test("valid explicit profile replaces as before and reads the catalog exactly once", async () => {
    const h = await harness();
    const result = await h.acquire({ runtime: RUNTIME, deviceType: "pixel_9" });
    expect(result).toMatchObject({ outcome: "ready", disposition: "replaced" });
    expect(h.deleter.stableIds()).toEqual([OLD]);
    expect(h.provisioner.created()).toHaveLength(1);
    expect(h.provisioner.created()[0]?.spec.deviceType).toBe("pixel_9");
    expect(h.profiles.calls).toHaveLength(1);
  });

  test("replacement reads the profile catalog before checking device claims", async () => {
    const h = await harness();
    const order: string[] = [];
    h.profiles.read = async () => {
      order.push("catalog");
      return h.profiles.ids;
    };
    h.claims.beforeDescribe = async () => {
      order.push("claims");
    };
    const claims = spyOn(h.claims, "describe");
    const result = await h.acquire({ runtime: RUNTIME, deviceType: "pixel_9" });
    expect(result).toMatchObject({ outcome: "ready", disposition: "replaced" });
    expect(order.slice(0, 2)).toEqual(["catalog", "claims"]);
    expect(claims).toHaveBeenCalledWith(expect.objectContaining({ name: OLD }));

    const unknown = await harness();
    const unknownClaims = spyOn(unknown.claims, "describe");
    const refused = await unknown.acquire({ runtime: RUNTIME, deviceType: UNKNOWN });
    expect(refused.failure?.code).toBe("spec_unsupported");
    expect(unknown.profiles.calls).toHaveLength(1);
    expect(unknownClaims).not.toHaveBeenCalled();
    await unknown.expectIntact();
  });

  test.each(["cancel", "timeout"])("%s wins over a pending catalog read failure", async (mode) => {
    const h = await harness();
    const controller = new AbortController();
    const pending = Promise.withResolvers<string[]>();
    h.profiles.read = () => pending.promise;
    let settled = false;
    const attempt = h
      .acquire({ runtime: RUNTIME, deviceType: "pixel_9" }, controller.signal)
      .then((result) => {
        settled = true;
        return result;
      });
    await drainUntil(() => h.profiles.calls.length > 0 || settled, {
      description: "profile read or legacy completion",
    });
    if (mode === "cancel") {
      controller.abort();
    } else {
      h.timer.advanceTime(60_001);
    }
    pending.reject(new Error("read interrupted"));
    // Observe the rejection even on the pre-fix path, which never reads the promise.
    void pending.promise.catch(() => {});
    const result = await attempt;
    expect(result).toMatchObject({
      outcome: "failed",
      failure: { code: mode === "cancel" ? "cancelled" : "timeout" },
    });
    expect(h.profiles.calls).toEqual([controller.signal]);
    await h.expectIntact();
  });

  test.each(["0", "Pixel 9", "PIXEL_9"])(
    "only exact profile IDs match, refusing %s",
    async (deviceType) => {
      const h = await harness();
      const result = await h.acquire({ runtime: RUNTIME, deviceType });
      expect(result.failure?.code).toBe("spec_unsupported");
      await h.expectIntact();
    },
  );

  test("adopting a matching leftover does not read the catalog", async () => {
    const h = await harness({ androidDefaultDeviceType: UNKNOWN });
    await h.registry.commitBinding(
      h.key,
      { generation: 1, stableDeviceId: OLD },
      {
        stableDeviceId: null,
        deviceName: null,
        resolvedSpec: null,
        specFingerprint: null,
        state: "provisioning",
      },
    );
    h.inventory.devices[0]!.name = managedSlotDeviceName(h.key, 3, "leftover");
    h.profiles.read = async () => {
      throw new Error("unreadable");
    };
    const result = await h.acquire({ runtime: RUNTIME });
    expect(result).toMatchObject({ outcome: "ready", disposition: "adopted" });
    expect(h.profiles.calls).toEqual([]);
    expect(h.provisioner.created()).toEqual([]);
  });

  test("a resolver without a profile catalog retains legacy creation behavior", async () => {
    const h = await harness({ androidProfileCatalog: undefined });
    const result = await h.acquire({ runtime: RUNTIME, deviceType: UNKNOWN });
    expect(result).toMatchObject({ outcome: "ready", disposition: "replaced" });
    expect(h.provisioner.created()[0]?.spec.deviceType).toBe(UNKNOWN);
    expect(h.profiles.calls).toEqual([]);
  });
});
