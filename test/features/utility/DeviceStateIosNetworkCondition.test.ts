import { afterEach, describe, expect, spyOn, test } from "bun:test";
import type { BootedDevice } from "../../../src/models";
import { DeviceState } from "../../../src/features/utility/DeviceState";
import {
  NETWORK_FILTER_CONTRACT_VERSION,
  NETWORK_FILTER_INSTALL_COMMAND,
  type NetworkFilterBridge,
  type NetworkFilterState,
} from "../../../src/features/network-filter/NetworkFilterBridge";
import { getDeviceStateResultSchema } from "../../../src/server/toolOutputSchemas";
import { logger } from "../../../src/utils/logger";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeNetworkFilterBridge } from "../../fakes/FakeNetworkFilterBridge";

const iosSimulator: BootedDevice = {
  name: "iPhone 16",
  platform: "ios",
  deviceId: "12345678-1234-1234-1234-123456789ABC",
  iosVersion: "18.6",
};

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

/** The distinguishing text each state's message and next step must carry. */
const STATE_MESSAGES: Record<NetworkFilterState, string> = {
  not_installed: NETWORK_FILTER_INSTALL_COMMAND,
  installation_required: "not a signed, provisioned build",
  approval_required: "System Settings > General > Login Items & Extensions > Network Extensions",
  unavailable: "did not answer",
  ready: "offline/reset is not implemented yet (#10264)",
};

const STATES = Object.keys(STATE_MESSAGES) as NetworkFilterState[];

describe("DeviceState iOS Simulator networkCondition backend (#10590)", () => {
  let warn: ReturnType<typeof spyOn<typeof logger, "warn">> | undefined;

  afterEach(() => {
    warn?.mockRestore();
    warn = undefined;
  });

  for (const state of STATES) {
    test(`getDeviceState reports the ${state} backend state with its next step`, async () => {
      const bridge = new FakeNetworkFilterBridge();
      bridge.setState(state, `controller says ${state}`);

      const result = await new DeviceState(iosSimulator, {
        networkFilterBridge: bridge,
      }).getState(["networkCondition"]);

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
      expect(result.networkCondition?.controller?.nextStep).toContain(STATE_MESSAGES[state]);
      expect(result.networkCondition?.error).toContain(STATE_MESSAGES[state]);
      // A read never claims an applied or verified condition before #10264.
      expect(result.networkCondition?.verified).toBeUndefined();
      expect(result.networkCondition?.profile).toBeUndefined();
      expect(bridge.statusCalls).toBe(1);
      expect(bridge.snapshotCalls).toBe(0);
      expect(getDeviceStateResultSchema.safeParse({ message: "ok", ...result }).success).toBe(true);
    });

    test(`setDeviceState refuses with the ${state} message and applies nothing`, async () => {
      const bridge = new FakeNetworkFilterBridge();
      bridge.setState(state);

      const result = await new DeviceState(iosSimulator, {
        networkFilterBridge: bridge,
      }).setState({ networkCondition: { profile: "offline" } });

      expect(result.success).toBe(false);
      expect(result.networkCondition).toMatchObject({
        supported: false,
        capability: "unsupported",
        backend: "network-extension",
        controller: { state },
        requestedProfile: "offline",
        verified: false,
      });
      expect(result.networkCondition?.error).toContain(STATE_MESSAGES[state]);
      expect(result.networkCondition?.error).not.toContain("host-side proxy");
      expect(result.networkCondition?.appliedProfile).toBeUndefined();
    });
  }

  test("each state carries a distinct message", () => {
    const steps = STATES.map((state) => STATE_MESSAGES[state]);
    expect(new Set(steps).size).toBe(STATES.length);
  });

  test("a throwing bridge reads as unavailable, logged with logger.warn", async () => {
    warn = spyOn(logger, "warn").mockImplementation(() => {});
    const bridge: NetworkFilterBridge = {
      status: async () => {
        throw new Error("bridge exploded");
      },
      snapshot: async () => {
        throw new Error("bridge exploded");
      },
    };

    const result = await new DeviceState(iosSimulator, { networkFilterBridge: bridge }).getState([
      "networkCondition",
    ]);

    expect(result.networkCondition?.controller).toMatchObject({
      state: "unavailable",
      detail: "bridge exploded",
    });
    expect(warn).toHaveBeenCalledTimes(1);
  });

  test("physical iOS keeps its unsupported result without consulting the bridge", async () => {
    const bridge = new FakeNetworkFilterBridge();
    bridge.setState("ready");
    const deviceState = new DeviceState(physicalIos, { networkFilterBridge: bridge });

    const read = await deviceState.getState(["networkCondition"]);
    const write = await deviceState.setState({ networkCondition: { profile: "3g" } });

    expect(read.networkCondition).toEqual({
      supported: false,
      capability: "unsupported",
      error: expect.stringContaining("physical iOS device"),
    });
    expect(write.networkCondition).toMatchObject({
      supported: false,
      capability: "unsupported",
      requestedProfile: "3g",
      verified: false,
    });
    expect(write.networkCondition?.backend).toBeUndefined();
    expect(write.networkCondition?.error).not.toContain("host-side proxy");
    expect(bridge.statusCalls).toBe(0);
  });

  test("Android never consults the bridge", async () => {
    const bridge = new FakeNetworkFilterBridge();
    const result = await new DeviceState(androidPhysical, {
      adbFactory: new FakeAdbClientFactory(),
      networkFilterBridge: bridge,
    }).getState(["networkCondition"]);

    expect(result.networkCondition?.backend).toBeUndefined();
    expect(bridge.statusCalls).toBe(0);
  });
});
