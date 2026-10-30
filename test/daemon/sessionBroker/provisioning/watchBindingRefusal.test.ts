import { beforeEach, describe, expect, test } from "bun:test";
import {
  BindingReconciler,
  computeManagedSpecFingerprint,
  DefaultManagedSpecMatcher,
  DefaultManagedSpecResolver,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import type { ManagedSpecResolver } from "../../../../src/daemon/sessionBroker/provisioning/DefaultManagedSpecResolver";
import { recordedSpec } from "../../../../src/daemon/sessionBroker/registry/bindingJournalRecords";
import {
  WATCH_BINDING_UNSUPPORTED_MESSAGE,
  type BindingJournalTarget,
  type BindingKey,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeCapacity,
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "../registry/fixtures/reconcilerFakes";

const WATCH_SPEC = {
  runtime: "com.apple.CoreSimulator.SimRuntime.watchOS-11-0",
  deviceType: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Series-10-46mm",
};

/** Resolves anything, so only the reconciler's own platform guard can refuse a watch. */
class PermissiveResolver implements ManagedSpecResolver {
  readonly platforms: string[] = [];
  async resolve(platform: Parameters<ManagedSpecResolver["resolve"]>[0]) {
    this.platforms.push(platform);
    const resolvedSpec = { ...WATCH_SPEC, displayCutout: "unknown" as const };
    return {
      kind: "resolved" as const,
      resolvedSpec,
      fingerprint: computeManagedSpecFingerprint(platform, resolvedSpec),
    };
  }
}

describe("broker-managed watch bindings are refused until supported (#15882)", () => {
  let timer: FakeTimer;
  let registry: FakeBindingRegistry;
  let inventory: FakeInventory;
  let provisioner: FakeProvisioner;
  let deleter: FakeDeleter;
  let capacity: FakeCapacity;
  let resolver: PermissiveResolver;
  let key: BindingKey;
  const listed: string[] = [];

  beforeEach(async () => {
    timer = new FakeTimer();
    registry = new FakeBindingRegistry(timer);
    inventory = new FakeInventory();
    listed.length = 0;
    inventory.beforeList = async (platform) => {
      listed.push(platform);
    };
    provisioner = new FakeProvisioner(inventory);
    deleter = new FakeDeleter(inventory);
    capacity = new FakeCapacity();
    resolver = new PermissiveResolver();
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "ns",
      runnerIncarnation: "inc",
    });
    if (scope.kind !== "ready") {
      throw new Error("scope setup failed");
    }
    key = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
  });

  function reconciler(withResolver: ManagedSpecResolver = resolver) {
    return new BindingReconciler({
      registry,
      inventory,
      matcher: new FakeMatcher(),
      resolver: withResolver,
      provisioner,
      deleter,
      claims: new FakeClaims(),
      capacity,
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: () => true,
    });
  }

  test("a watch reconcile fails spec_unsupported before resolution, registry or native work", async () => {
    const result = await reconciler().reconcile({
      key,
      role: "app",
      platform: "watchos",
      requestedSpec: WATCH_SPEC,
      deadlineMs: timer.now() + 60_000,
    });
    expect(result).toMatchObject({
      outcome: "failed",
      failure: {
        code: "spec_unsupported",
        retryable: false,
        message: WATCH_BINDING_UNSUPPORTED_MESSAGE,
      },
    });
    expect(resolver.platforms).toEqual([]);
    expect(await registry.getAssignment(key)).toBeNull();
    expect(listed).toEqual([]);
    expect(provisioner.calls).toEqual([]);
    expect(capacity.checks).toBe(0);
  });

  test("the default resolver never resolves or checks creatability of a watch spec as iOS", async () => {
    const real = new DefaultManagedSpecResolver();
    const refusal = {
      kind: "unsupported",
      code: "spec_unsupported",
      message: WATCH_BINDING_UNSUPPORTED_MESSAGE,
    } as const;
    expect(await real.resolve("watchos", WATCH_SPEC, {})).toEqual(refusal);
    expect(
      await real.checkCreatable("watchos", { ...WATCH_SPEC, displayCutout: "unknown" }, {}),
    ).toEqual(refusal);
  });

  test("a watch is never matched against a spec, so it is never judged a mismatch to delete", async () => {
    const matcher = new DefaultManagedSpecMatcher({
      readConfig: async () => {
        throw new Error("a watch has no AVD config");
      },
    });
    const watch = {
      platform: "watchos" as const,
      name: "ambroker-watch",
      deviceId: "W-1",
      isRunning: false,
      runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
      deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
    };
    expect(
      await matcher.matches(watch, {
        runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-0",
        deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
      }),
    ).toBe("unknown");
  });

  test("a watch journal entry's spec is never read with the iOS schema", () => {
    const target: BindingJournalTarget = {
      oldStableId: null,
      oldName: null,
      newName: "ambroker-watch",
      newStableId: null,
      requestedSpec: WATCH_SPEC,
      resolvedSpec: null,
      specFingerprint: null,
    };
    expect(recordedSpec({ platform: "ios", target: { ...target, newPlatform: "watchos" } })).toBe(
      undefined,
    );
    expect(recordedSpec({ platform: "watchos", target })).toBeUndefined();
    expect(recordedSpec({ platform: "ios", target })).toEqual(WATCH_SPEC);
  });
});
