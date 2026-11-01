import { afterEach, describe, expect, spyOn, test } from "bun:test";
import {
  handleDeviceConditionCall,
  registerDeviceConditionFeatureFlags,
  withDeviceConditionDispatch,
} from "../../src/server/deviceConditionTool";
import { DeviceConditionRegistry } from "../../src/features/deviceCondition/DeviceConditionRegistry";
import type { BootedDevice } from "../../src/models";
import { toolText, toolStructured } from "../helpers/toolResponse";

const device: BootedDevice = {
  name: "emulator-5554",
  platform: "android",
  deviceId: "emulator-5554",
};
const flagOn = { isEnabled: () => true };
const flagOff = { isEnabled: () => false };

function freshRegistry() {
  // No injectors: a non-unset condition is unsupported, which is what this foundational drop ships.
  return new DeviceConditionRegistry(() => undefined);
}

describe("handleDeviceConditionCall (#14050)", () => {
  test("refuses when the feature flag is off", async () => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: { rootState: "unset" }, sessionUuid: "s" },
      { featureFlags: flagOff, registry: freshRegistry() },
    );
    expect(toolStructured(response).success).toBe(false);
    expect(toolText(response)).toMatch(/feature flag/);
  });

  test("refuses mixing deviceCondition with other setDeviceState fields", async () => {
    const response = await handleDeviceConditionCall(
      device,
      {
        deviceCondition: { rootState: "unset" },
        doNotDisturb: { enabled: true },
        sessionUuid: "s",
      },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    expect(toolStructured(response).success).toBe(false);
    expect(toolText(response)).toMatch(/cannot be combined/);
  });

  test("refuses an empty deviceCondition request", async () => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: {}, sessionUuid: "s" },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    expect(toolStructured(response).success).toBe(false);
    expect(toolText(response)).toMatch(/reset or at least one condition/);
  });

  test("refuses an invalid deviceCondition value", async () => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: { rootState: "fully-rooted" }, sessionUuid: "s" },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    expect(toolStructured(response).success).toBe(false);
    expect(toolText(response)).toMatch(/Invalid deviceCondition/);
  });

  test("accepts rooted-detectable and reports it unsupported when no injector is registered", async () => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: { rootState: "rooted-detectable" }, sessionUuid: "s" },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    expect(toolText(response)).not.toMatch(/Invalid deviceCondition/);
    expect(toolStructured(response).success).toBe(false);
  });

  test("refuses a lease in direct mode (no session to enforce it)", async () => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: { reset: true, expiresInSeconds: 30 } },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    expect(toolStructured(response).success).toBe(false);
    expect(toolText(response)).toMatch(/no lifecycle owner|needs a session/);
  });

  test.each([undefined, ""])(
    "refuses rooted-detectable with sessionUuid=%j before applying anything",
    async (sessionUuid) => {
      const registry = freshRegistry();
      const apply = spyOn(registry, "apply");
      const response = await handleDeviceConditionCall(
        device,
        { deviceCondition: { rootState: "rooted-detectable" }, sessionUuid },
        { featureFlags: flagOn, registry },
      );
      expect(apply).not.toHaveBeenCalled();
      expect(toolStructured(response).success).toBe(false);
      expect(toolText(response)).toMatch(/rootState needs a session \(sessionUuid\)/);
      expect(toolText(response)).toMatch(/restored when the session ends/);
      expect(toolText(response)).toMatch(/sessionless.*unset.*clear/);
    },
  );

  test.each([{ rootState: "unset" } as const, { reset: true } as const])(
    "allows sessionless cleanup %j to reach the registry",
    async (deviceCondition) => {
      const registry = freshRegistry();
      const apply = spyOn(registry, "apply");
      const response = await handleDeviceConditionCall(
        device,
        { deviceCondition },
        { featureFlags: flagOn, registry },
      );
      expect(toolStructured(response).success).toBe(true);
      expect(apply).toHaveBeenCalledTimes(1);
      expect(apply).toHaveBeenCalledWith(
        { deviceId: device.deviceId, sessionUuid: undefined, device },
        deviceCondition,
      );
    },
  );

  test("applies session-owned rooted-detectable through the registry", async () => {
    const registry = new DeviceConditionRegistry(() => ({
      key: "rootState",
      apply: async () => ({ status: "applied" }),
      isClean: async () => true,
    }));
    const apply = spyOn(registry, "apply");
    const deviceCondition = { rootState: "rooted-detectable" } as const;
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition, sessionUuid: "s" },
      { featureFlags: flagOn, registry },
    );
    expect(toolStructured(response).success).toBe(true);
    expect(apply).toHaveBeenCalledTimes(1);
    expect(apply).toHaveBeenCalledWith(
      { deviceId: device.deviceId, sessionUuid: "s", device },
      deviceCondition,
    );
  });

  test("applies a reset and reports the structured deviceCondition result", async () => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: { reset: true }, sessionUuid: "s" },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    const structured = toolStructured(response) as {
      success: boolean;
      deviceCondition: { version: number; active: unknown[] };
    };
    expect(structured.success).toBe(true);
    expect(structured.deviceCondition.version).toBe(1);
    expect(structured.deviceCondition.active).toEqual([]);
  });
});

describe("deviceCondition setDeviceState wiring", () => {
  afterEach(() => registerDeviceConditionFeatureFlags({ isEnabled: () => false }));

  test("refuses mixing deviceCondition with screenLock", async () => {
    const response = await handleDeviceConditionCall(
      device,
      {
        deviceCondition: { rootState: "unset" },
        screenLock: { type: "pin", credential: "1357" },
        sessionUuid: "s",
      },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    expect(toolStructured(response).success).toBe(false);
    expect(toolText(response)).toMatch(/cannot be combined/);
  });

  test("reads the registered feature flags when none are injected", async () => {
    registerDeviceConditionFeatureFlags(flagOn);
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: {}, sessionUuid: "s" },
      { registry: freshRegistry() },
    );
    expect(toolText(response)).toMatch(/reset or at least one condition/);
  });

  test("fails closed when no feature flags are registered", async () => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: { rootState: "unset" }, sessionUuid: "s" },
      { registry: freshRegistry() },
    );
    expect(toolText(response)).toMatch(/feature flag/);
  });

  test("dispatches only deviceCondition calls away from the wrapped handler", async () => {
    const calls: string[] = [];
    const handler = withDeviceConditionDispatch(
      async (_device: BootedDevice, args: { deviceCondition?: unknown; clock?: unknown }) => {
        calls.push(JSON.stringify(args));
        return "wrapped";
      },
    );
    expect(await handler(device, { clock: { reset: true } })).toBe("wrapped");
    const routed = await handler(device, { deviceCondition: { rootState: "unset" } });
    expect(routed).not.toBe("wrapped");
    expect(calls).toEqual([JSON.stringify({ clock: { reset: true } })]);
  });
});

describe("attestation ceiling refusal (#14074)", () => {
  test.each([
    [{ integrityState: "MEETS_STRONG_INTEGRITY" }, "integrityState"],
    [{ rootState: "verified" }, "rootState"],
    [{ integrity: { ctsProfileMatch: true } }, "integrity.ctsProfileMatch"],
  ])("refuses %j without applying anything", async (deviceCondition, field) => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition, sessionUuid: "s" },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    expect(toolStructured(response).success).toBe(false);
    expect(toolText(response)).toContain("attestation_ceiling");
    expect(toolText(response)).toContain(field);
    expect(toolText(response)).toMatch(/physical device/);
  });

  test("does not refuse an admissible request", async () => {
    const response = await handleDeviceConditionCall(
      device,
      { deviceCondition: { rootState: "unset" }, sessionUuid: "s" },
      { featureFlags: flagOn, registry: freshRegistry() },
    );
    expect(toolText(response)).not.toContain("attestation_ceiling");
  });
});
