import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import {
  DeviceState,
  IOS_APP_NETWORK_CONDITION_LIMITATIONS,
  iosAppNetworkRuleOutcome,
} from "../../../src/features/utility/DeviceState";
import {
  NETWORK_FILTER_CONTRACT_VERSION,
  NETWORK_FILTER_INSTALL_COMMAND,
  type NetworkFilterBridge,
  type NetworkFilterState,
} from "../../../src/features/network-filter/NetworkFilterBridge";
import type { IosAppNetworkRuleCommandContext } from "../../../src/features/network-filter/IosAppNetworkRuleClient";
import {
  getDeviceStateResultSchema,
  setDeviceStateResultSchema,
} from "../../../src/server/toolOutputSchemas";
import { logger } from "../../../src/utils/logger";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeNetworkFilterBridge } from "../../fakes/FakeNetworkFilterBridge";

const iosSimulator: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
  iosVersion: "18.6",
};

const siblingSimulator = "7B3A3792-DB53-4654-BA94-27A1D305C3B7";

const physicalIos: BootedDevice = {
  name: "iPhone",
  platform: "ios",
  deviceId: "00008110-001234567890801E",
};

const androidPhysical: BootedDevice = {
  name: "Pixel",
  platform: "android",
  deviceId: "R58M123ABC",
};

const APP = "com.example.app";

/** The distinguishing text each not-ready state's message and next step must carry. */
const NOT_READY_MESSAGES: Record<Exclude<NetworkFilterState, "ready">, string> = {
  not_installed: NETWORK_FILTER_INSTALL_COMMAND,
  installation_required: "not a signed, provisioned build",
  approval_required: "System Settings > General > Login Items & Extensions > Network Extensions",
  unavailable: "did not answer",
};

const NOT_READY = Object.keys(NOT_READY_MESSAGES) as Array<keyof typeof NOT_READY_MESSAGES>;

/** Session ownership as `runSessionNetworkMutation` hands it to the setter. */
function context(owner = "session-a", revision = 1): IosAppNetworkRuleCommandContext {
  let last = revision;
  return {
    rule: { udid: iosSimulator.deviceId, bundleId: APP, owner, ownerGeneration: 500, revision },
    nextRevision: () => ++last,
  };
}

function deviceState(
  bridge: NetworkFilterBridge,
  rule?: IosAppNetworkRuleCommandContext,
  device: BootedDevice = iosSimulator,
): DeviceState {
  return new DeviceState(device, {
    networkFilterBridge: bridge,
    iosAppNetworkRule: () => rule,
    adbFactory: new FakeAdbClientFactory(),
  });
}

describe("DeviceState iOS Simulator networkCondition (#10590, #10264)", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">> | undefined;

  afterEach(() => {
    warn?.mockRestore();
    warn = undefined;
  });

  for (const state of NOT_READY) {
    test(`getDeviceState reports the ${state} backend state with its next step`, async () => {
      const bridge = new FakeNetworkFilterBridge();
      bridge.setState(state, `controller says ${state}`);

      const result = await deviceState(bridge).getState(["networkCondition"]);

      expect(result.success).toBe(true);
      expect(result.unsupported).toEqual(["networkCondition"]);
      expect(result.networkCondition).toMatchObject({
        supported: false,
        capability: "unsupported",
        backend: "network-extension",
        controller: { state, detail: `controller says ${state}` },
      });
      expect(result.networkCondition?.controller?.contractVersion).toBe(
        state === "not_installed" ? undefined : NETWORK_FILTER_CONTRACT_VERSION,
      );
      expect(result.networkCondition?.controller?.nextStep).toContain(NOT_READY_MESSAGES[state]);
      expect(result.networkCondition?.error).toContain(NOT_READY_MESSAGES[state]);
      expect(result.networkCondition?.rules).toBeUndefined();
      expect(bridge.statusCalls).toBe(1);
      expect(getDeviceStateResultSchema.safeParse({ message: "ok", ...result }).success).toBe(true);
    });

    test(`offline for an app reports the ${state} message and nothing is applied`, async () => {
      const bridge = new FakeNetworkFilterBridge();
      bridge.setState(state);

      const result = await deviceState(bridge, context()).setState({
        networkCondition: { profile: "offline", appId: APP },
      });

      expect(result.success).toBe(false);
      expect(result.networkCondition).toMatchObject({
        backend: "network-extension",
        controller: { state },
        requestedProfile: "offline",
        verified: false,
      });
      // `unavailable` is an uncertain answer: reconciled, then rolled back.
      expect(result.networkCondition?.supported).toBe(state === "unavailable");
      expect(result.networkCondition?.error).toContain(NOT_READY_MESSAGES[state]);
      expect(result.networkCondition?.appliedProfile).toBeUndefined();
      expect(bridge.activeRules()).toEqual([]);
      expect(iosAppNetworkRuleOutcome(result)).toBe("unchanged");
    });
  }

  test("getDeviceState reads this simulator's rules from the provider", async () => {
    const bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");
    await bridge.apply({ udid: iosSimulator.deviceId, bundleId: APP }, context().rule, 15_000);
    await bridge.apply(
      { udid: siblingSimulator, bundleId: APP },
      { owner: "session-b", ownerGeneration: 1, revision: 1 },
      15_000,
    );

    const result = await deviceState(bridge).getState(["networkCondition"]);

    expect(result.success).toBe(true);
    expect(result.unsupported).toBeUndefined();
    expect(result.networkCondition).toMatchObject({
      supported: true,
      capability: "partial",
      backend: "network-extension",
      controller: { state: "ready" },
      scope: "app",
      coverage: "partial",
      rules: [
        {
          appId: APP,
          profile: "offline",
          revision: 1,
          ownerGeneration: 500,
          owner: "session-a",
          leaseExpiresInMs: 15_000,
          droppedFlows: 0,
        },
      ],
    });
    expect(result.networkCondition?.limitations).toEqual([
      ...IOS_APP_NETWORK_CONDITION_LIMITATIONS,
    ]);
    expect(result.networkCondition?.verified).toBeUndefined();
    expect(getDeviceStateResultSchema.safeParse({ message: "ok", ...result }).success).toBe(true);
  });

  test("a device-wide request is refused without contacting the controller", async () => {
    const bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");

    const result = await deviceState(bridge, context()).setState({
      networkCondition: { profile: "offline" },
    });

    expect(result.success).toBe(false);
    expect(result.networkCondition).toMatchObject({
      supported: false,
      scope: "device",
      requestedProfile: "offline",
      verified: false,
    });
    expect(result.networkCondition?.error).toContain("networkCondition.appId");
    expect(bridge.ruleCalls).toEqual([]);
    expect(bridge.statusCalls).toBe(0);
  });

  for (const input of [
    { profile: "3g" as const, named: "profile `3g`" },
    { profile: "none" as const, delayMs: 300, named: "`delayMs`" },
    { packetLossPercent: 10, named: "`packetLossPercent`" },
  ]) {
    test(`unsupported shaping (${input.named}) is refused by name and not applied`, async () => {
      const bridge = new FakeNetworkFilterBridge();
      bridge.setState("ready");
      const { named, ...request } = input;

      const result = await deviceState(bridge, context()).setState({
        networkCondition: { ...request, appId: APP },
      });

      expect(result.success).toBe(false);
      expect(result.networkCondition).toMatchObject({ supported: false, scope: "app", appId: APP });
      expect(result.networkCondition?.error).toContain(named);
      expect(result.networkCondition?.error).toContain("#10265");
      expect(bridge.ruleCalls).toEqual([]);
    });
  }

  test("offline outside a session is refused: nothing would renew or remove the rule", async () => {
    const bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");

    const result = await deviceState(bridge).setState({
      networkCondition: { profile: "offline", appId: APP },
    });

    expect(result.success).toBe(false);
    expect(result.networkCondition?.error).toContain("needs a daemon session");
    expect(bridge.ruleCalls).toEqual([]);
  });

  test("offline for an app is applied, acknowledged and reported with its revision and lease", async () => {
    const bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");

    const result = await deviceState(bridge, context()).setState({
      networkCondition: { profile: "offline", appId: APP },
    });

    expect(result.success).toBe(true);
    expect(result.networkCondition).toMatchObject({
      supported: true,
      capability: "partial",
      backend: "network-extension",
      scope: "app",
      appId: APP,
      requestedProfile: "offline",
      appliedProfile: "offline",
      acknowledged: true,
      coverage: "partial",
      rule: { appId: APP, profile: "offline", revision: 1, ownerGeneration: 500 },
    });
    expect(result.networkCondition?.rule?.leaseExpiresInMs).toBe(15_000);
    expect(result.networkCondition?.verified).toBeUndefined();
    expect(bridge.ruleCalls.map((call) => call.leaseMs)).toEqual([15_000]);
    expect(iosAppNetworkRuleOutcome(result)).toBe("installed");
    expect(setDeviceStateResultSchema.safeParse({ message: "ok", ...result }).success).toBe(true);
  });

  test("a failed apply is rolled back and reported as a failure", async () => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    const bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");
    bridge.ruleScripts.push("dropped");

    const result = await deviceState(bridge, context()).setState({
      networkCondition: { profile: "offline", appId: APP },
    });

    expect(result.success).toBe(false);
    expect(result.networkCondition?.error).toContain("rolled back");
    expect(bridge.ruleCalls.map((call) => [call.command, call.ownership.revision])).toEqual([
      ["apply", 1],
      ["reset", 2],
    ]);
    expect(iosAppNetworkRuleOutcome(result)).toBe("unchanged");
  });

  test("none for an app removes this session's rule", async () => {
    const bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");
    await deviceState(bridge, context()).setState({
      networkCondition: { profile: "offline", appId: APP },
    });

    const result = await deviceState(bridge, context("session-a", 2)).setState({
      networkCondition: { profile: "none", appId: APP },
    });

    expect(result.success).toBe(true);
    expect(result.networkCondition).toMatchObject({
      appliedProfile: "none",
      profile: "none",
      acknowledged: true,
      scope: "app",
    });
    expect(bridge.activeRules()).toEqual([]);
    expect(iosAppNetworkRuleOutcome(result)).toBe("removed");
  });

  test("another session's reset cannot clear the rule", async () => {
    const bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");
    await deviceState(bridge, context("session-a")).setState({
      networkCondition: { profile: "offline", appId: APP },
    });

    const result = await deviceState(bridge, context("session-b", 9)).setState({
      networkCondition: { reset: true, appId: APP },
    });

    expect(result.success).toBe(false);
    expect(result.networkCondition?.error).toContain("Another session holds the offline rule");
    expect(bridge.activeRules().map((rule) => rule.owner)).toEqual(["session-a"]);
    expect(iosAppNetworkRuleOutcome(result)).toBe("unchanged");
  });

  test("a throwing bridge reads as unavailable, logged with logger.warn", async () => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    const failing = async () => {
      throw new Error("bridge exploded");
    };
    const bridge: NetworkFilterBridge = {
      status: failing,
      snapshot: failing,
      apply: failing,
      reset: failing,
      renew: failing,
    };

    const result = await deviceState(bridge).getState(["networkCondition"]);

    expect(result.networkCondition?.controller).toMatchObject({
      state: "unavailable",
      detail: "bridge exploded",
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("physical iOS stays unsupported without consulting the bridge", async () => {
    const bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");
    const physical = deviceState(bridge, context(), physicalIos);

    const read = await physical.getState(["networkCondition"]);
    const write = await physical.setState({ networkCondition: { profile: "offline", appId: APP } });

    expect(read.networkCondition).toEqual({
      supported: false,
      capability: "unsupported",
      error: expect.stringContaining("physical iOS device"),
    });
    expect(write.networkCondition).toMatchObject({
      supported: false,
      capability: "unsupported",
      requestedProfile: "offline",
      verified: false,
    });
    expect(write.networkCondition?.backend).toBeUndefined();
    expect(bridge.statusCalls).toBe(0);
    expect(bridge.ruleCalls).toEqual([]);
  });

  test("Android never consults the bridge and refuses appId", async () => {
    const bridge = new FakeNetworkFilterBridge();
    const android = deviceState(bridge, undefined, androidPhysical);

    const read = await android.getState(["networkCondition"]);
    const write = await android.setState({ networkCondition: { profile: "offline", appId: APP } });

    expect(read.networkCondition?.backend).toBeUndefined();
    expect(write.networkCondition?.error).toContain("appId applies only to iOS Simulator");
    expect(bridge.statusCalls).toBe(0);
  });
});
