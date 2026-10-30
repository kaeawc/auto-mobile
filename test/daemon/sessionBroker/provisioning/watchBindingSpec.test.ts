import { beforeEach, describe, expect, test } from "bun:test";
import {
  BindingReconciler,
  computeManagedSpecFingerprint,
  DefaultManagedSpecMatcher,
  DefaultManagedSpecResolver,
  type BindingProvisionRequest,
  type BindingProvisionedDevice,
} from "../../../../src/daemon/sessionBroker/provisioning/reconciler";
import { isBindingReady } from "../../../../src/daemon/sessionBroker/provisioning/bindingReadiness";
import { ToolBindingProvisioner } from "../../../../src/daemon/sessionBroker/provisioning/reconcilerPorts";
import { recordedSpec } from "../../../../src/daemon/sessionBroker/registry/bindingJournalRecords";
import type {
  BindingJournalTarget,
  BindingKey,
  BindingPlatform,
} from "../../../../src/daemon/sessionBroker/registry/bindingRegistry";
import type { DeviceInfo } from "../../../../src/models/index";
import { WatchSimulatorInventory } from "../../../../src/utils/ios-cmdline-tools/WatchSimulatorInventory";
import { FakeBindingRegistry } from "../../../fakes/FakeBindingRegistry";
import { FakeIdGenerator } from "../../../fakes/FakeIdGenerator";
import { FakeTimer } from "../../../fakes/FakeTimer";
import {
  FakeWatchSimctl,
  WATCH_DEVICE_TYPE,
  WATCH_RUNTIME,
  WATCH_RUNTIME_ID,
} from "../../../fakes/FakeWatchSimctl";
import {
  FakeCapacity,
  FakeClaims,
  FakeDeleter,
  FakeInventory,
  FakeMatcher,
  FakeProvisioner,
} from "../registry/fixtures/reconcilerFakes";

const SPEC = { runtime: WATCH_RUNTIME_ID, deviceType: WATCH_DEVICE_TYPE.identifier };

function watch(overrides: Partial<DeviceInfo> = {}): DeviceInfo {
  return {
    platform: "watchos",
    name: "ambroker-watch",
    deviceId: "W-1",
    isRunning: false,
    runtime: SPEC.runtime,
    deviceType: SPEC.deviceType,
    ...overrides,
  };
}

describe("watch spec matching (#15882)", () => {
  const matcher = new DefaultManagedSpecMatcher({
    readConfig: async () => {
      throw new Error("a watch is never matched through an AVD config");
    },
  });

  test("matches on exact runtime and device type, and nothing else", async () => {
    expect(await matcher.matches(watch(), SPEC)).toBe("match");
    expect(
      await matcher.matches(
        watch({ runtime: "com.apple.CoreSimulator.SimRuntime.watchOS-10-5" }),
        SPEC,
      ),
    ).toBe("mismatch");
    expect(
      await matcher.matches(
        watch({ deviceType: "com.apple.CoreSimulator.SimDeviceType.Apple-Watch-Ultra-2-49mm" }),
        SPEC,
      ),
    ).toBe("mismatch");
  });

  test("an unreadable or unavailable watch, or a spec without a device type, is unknown, never a mismatch", async () => {
    expect(await matcher.matches(watch({ isAvailable: false }), SPEC)).toBe("unknown");
    expect(await matcher.matches(watch({ runtime: undefined }), SPEC)).toBe("unknown");
    expect(await matcher.matches(watch({ deviceType: undefined }), SPEC)).toBe("unknown");
    expect(await matcher.matches(watch(), { runtime: SPEC.runtime })).toBe("unknown");
  });
});

describe("watch spec resolution against the watch catalog (#15882)", () => {
  let simctl: FakeWatchSimctl;
  let resolver: DefaultManagedSpecResolver;

  beforeEach(() => {
    simctl = new FakeWatchSimctl();
    simctl.runtimes = [WATCH_RUNTIME];
    simctl.deviceTypes = [WATCH_DEVICE_TYPE];
    resolver = new DefaultManagedSpecResolver(undefined, {
      watchCatalog: new WatchSimulatorInventory(simctl),
    });
  });

  test("an installed watch spec resolves exactly, fingerprinted as a watch", async () => {
    const resolvedSpec = { ...SPEC, displayCutout: "unknown" as const };
    expect(await resolver.resolve("watchos", SPEC, {})).toEqual({
      kind: "resolved",
      resolvedSpec,
      fingerprint: computeManagedSpecFingerprint("watchos", resolvedSpec),
    });
    expect(computeManagedSpecFingerprint("watchos", resolvedSpec)).not.toEqual(
      computeManagedSpecFingerprint("ios", resolvedSpec),
    );
    expect(await resolver.checkCreatable("watchos", resolvedSpec, {})).toEqual({
      kind: "creatable",
    });
  });

  test("an uninstalled runtime or device type is spec_unsupported, naming the installed ones", async () => {
    const runtime = await resolver.resolve(
      "watchos",
      { ...SPEC, runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-6" },
      {},
    );
    const deviceType = await resolver.resolve(
      "watchos",
      { ...SPEC, deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16" },
      {},
    );
    expect(runtime).toMatchObject({ kind: "unsupported", code: "spec_unsupported" });
    expect(runtime.kind === "unsupported" && runtime.message).toContain(WATCH_RUNTIME_ID);
    expect(deviceType).toMatchObject({ kind: "unsupported", code: "spec_unsupported" });
    expect(deviceType.kind === "unsupported" && deviceType.message).toContain(
      WATCH_DEVICE_TYPE.identifier,
    );
  });

  test("an installed but unavailable runtime is runtime_incompatible", async () => {
    simctl.runtimes = [{ ...WATCH_RUNTIME, isAvailable: false, availabilityError: "unmounted" }];
    const resolution = await resolver.resolve("watchos", SPEC, {});
    expect(resolution).toMatchObject({ kind: "unsupported", code: "runtime_incompatible" });
    expect(resolution.kind === "unsupported" && resolution.message).toContain("unmounted");
  });

  test("a spec that is not exactly runtime and device type is refused, never read as iOS", async () => {
    for (const spec of [
      { runtime: SPEC.runtime },
      { ...SPEC, deviceFamily: "watch" as const },
      { ...SPEC, displayCutout: "any" as const },
    ]) {
      expect(await resolver.resolve("watchos", spec, {})).toMatchObject({
        kind: "unsupported",
        code: "spec_unsupported",
      });
    }
  });

  test("no watch catalog cannot host a watch; an unreadable one is retryable", async () => {
    expect(await new DefaultManagedSpecResolver().resolve("watchos", SPEC, {})).toMatchObject({
      kind: "unsupported",
      code: "spec_unsupported",
    });
    simctl.catalogError = new Error("simctl timed out");
    expect(await resolver.resolve("watchos", SPEC, {})).toMatchObject({ kind: "unresolved" });
  });

  test("a watch journal entry's spec is read with the watch schema, never the iOS one", () => {
    const target: BindingJournalTarget = {
      oldStableId: null,
      oldName: null,
      newName: "ambroker-watch",
      newStableId: null,
      requestedSpec: SPEC,
      resolvedSpec: null,
      specFingerprint: null,
    };
    expect(recordedSpec({ platform: "watchos", target })).toEqual(SPEC);
    expect(
      recordedSpec({ platform: "ios", target: { ...target, newPlatform: "watchos" } }),
    ).toEqual(SPEC);
    expect(
      recordedSpec({
        platform: "watchos",
        target: { ...target, requestedSpec: { runtime: SPEC.runtime } },
      }),
    ).toBeUndefined();
  });
});

describe("the provisionDevice port for a watch binding (#15882)", () => {
  function provisioner(calls: Array<Record<string, unknown>>) {
    return new ToolBindingProvisioner({
      invokeTool: async (_name, args) => {
        calls.push(args);
        return {
          structuredContent: {
            device: {
              name: "ambroker-w",
              identity: { stableId: "W-9" },
              runtime: { deviceId: "W-9" },
            },
            created: true,
            sessionId: "session-w",
            readiness: { mode: "none", status: "device_ready" },
          },
        };
      },
      deviceManager: {
        listDeviceImages: async () => {
          throw new Error("a watch model is never read from the iOS listing");
        },
      },
      androidConfigReader: { readConfig: async () => null },
      timer: new FakeTimer(),
      releaseSession: async () => {},
      discardAndroidSnapshotOnExit: () => true,
    });
  }

  test("creates through the watch path at readiness none, and reuses by UDID", async () => {
    const calls: Array<Record<string, unknown>> = [];
    const port = provisioner(calls);
    const base: BindingProvisionRequest = {
      platform: "watchos",
      name: "ambroker-w",
      spec: SPEC,
      mode: "create",
      deadlineMs: 10_000,
    };

    const created = await port.provision(base);
    await port.provision({ ...base, mode: "adopt", deviceId: "W-9" });

    expect(created).toMatchObject({
      device: { stableId: "W-9", name: "ambroker-w" },
      sessionUuid: "session-w",
      readiness: { mode: "none", status: "device_ready" },
    });
    expect(calls).toEqual([
      {
        device: { platform: "watchos", name: "ambroker-w", spec: SPEC },
        boot: true,
        readiness: "none",
        timeoutMs: 10_000,
      },
      {
        device: { platform: "watchos", name: "ambroker-w", deviceId: "W-9", spec: SPEC },
        boot: true,
        readiness: "none",
        timeoutMs: 10_000,
      },
    ]);
  });

  test("reads a listed watch's own runtime and device type; an unavailable one is unreadable", async () => {
    const port = provisioner([]);
    expect(await port.readExistingSpec(watch())).toEqual({ ...SPEC, displayCutout: "unknown" });
    expect(await port.readExistingSpec(watch({ isAvailable: false }))).toBeNull();
  });
});

describe("binding readiness: booted for watchOS only (#15882)", () => {
  const booted = { sessionUuid: "s", readiness: { mode: "none", status: "device_ready" } };
  const automation = {
    sessionUuid: "s",
    readiness: { mode: "automation", status: "automation_ready" },
  };

  test("a watch is ready booted with a session; Android and iOS need the automation runner", () => {
    expect(isBindingReady("watchos", booted)).toBe(true);
    expect(isBindingReady("watchos", { ...booted, sessionUuid: "" })).toBe(false);
    expect(isBindingReady("watchos", automation)).toBe(false);
    for (const platform of ["android", "ios"] as const) {
      expect(isBindingReady(platform, automation)).toBe(true);
      expect(isBindingReady(platform, booted)).toBe(false);
      expect(isBindingReady(platform, { ...automation, sessionUuid: "" })).toBe(false);
    }
  });

  /** Reports a booted, session-bound device with no automation runner, whatever the platform. */
  class BootedOnlyProvisioner extends FakeProvisioner {
    override async provision(request: BindingProvisionRequest): Promise<BindingProvisionedDevice> {
      return { ...(await super.provision(request)), readiness: booted.readiness };
    }
  }

  async function reconcileBootedOnly(
    platform: BindingPlatform,
    spec: { runtime: string; deviceType: string },
  ) {
    const timer = new FakeTimer();
    const registry = new FakeBindingRegistry(timer);
    const inventory = new FakeInventory();
    const provisioner = new BootedOnlyProvisioner(inventory);
    const scope = await registry.ensureScope({
      managedHostScope: "host",
      runnerNamespace: "ns",
      runnerIncarnation: "inc",
    });
    if (scope.kind !== "ready") {
      throw new Error("scope setup failed");
    }
    const key: BindingKey = { scopeKey: scope.scope.scopeKey, bindingIndex: 0 };
    const resolvedSpec = { ...spec, displayCutout: "unknown" as const };
    const reconciler = new BindingReconciler({
      registry,
      inventory,
      matcher: new FakeMatcher(),
      resolver: {
        resolve: async () => ({
          kind: "resolved",
          resolvedSpec,
          fingerprint: computeManagedSpecFingerprint(platform, resolvedSpec),
        }),
      },
      provisioner,
      deleter: new FakeDeleter(inventory),
      claims: new FakeClaims(),
      capacity: new FakeCapacity(),
      timer,
      idGenerator: new FakeIdGenerator(),
      isExecOwnerLive: () => true,
    });
    const result = await reconciler.reconcile({
      key,
      role: "app",
      platform,
      requestedSpec: spec,
      deadlineMs: timer.now() + 60_000,
    });
    return { result, provisioner };
  }

  test("an iOS or Android binding that only booted is refused readiness_incomplete (regression)", async () => {
    for (const [platform, spec] of [
      [
        "ios",
        {
          runtime: "com.apple.CoreSimulator.SimRuntime.iOS-18-6",
          deviceType: "com.apple.CoreSimulator.SimDeviceType.iPhone-16",
        },
      ],
      [
        "android",
        { runtime: "system-images;android-35;google_apis;arm64-v8a", deviceType: "pixel_8" },
      ],
    ] as const) {
      const { result, provisioner } = await reconcileBootedOnly(platform, spec);
      expect(result).toMatchObject({
        outcome: "failed",
        failure: { code: "readiness_incomplete" },
      });
      expect(result.outcome === "failed" && result.failure.message).toContain(
        "automation readiness",
      );
      expect(provisioner.released).toEqual(["session-1"]);
    }
  });

  test("the same booted device is ready as a watch binding", async () => {
    const { result } = await reconcileBootedOnly("watchos", SPEC);
    expect(result).toMatchObject({
      outcome: "ready",
      disposition: "created",
      readiness: { mode: "none", status: "device_ready" },
    });
  });
});
