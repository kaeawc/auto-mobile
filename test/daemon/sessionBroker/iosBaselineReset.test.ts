import { describe, expect, test } from "bun:test";
import { IosBaselineReset } from "../../../src/daemon/sessionBroker/iosBaselineReset";
import type { BrokerNativeProfile } from "../../../src/daemon/sessionBroker/profile";
import { ActionableError } from "../../../src/models/ActionableError";
import type { BootedDevice, DeviceInfo } from "../../../src/models/DeviceInfo";

const UDID = "A1B2C3D4-E5F6-47A8-90AB-CDEF12345678";
const DEVICE_TYPE = "com.apple.CoreSimulator.SimDeviceType.iPhone-17-Pro";
const RUNTIME = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
const PROFILE: Extract<BrokerNativeProfile, { platform: "ios" }> = {
  platform: "ios",
  metadataState: "current",
  simulatorDeviceTypeIdentifier: DEVICE_TYPE,
  modelIdentifier: "iPhone18,1",
  archetype: "phone",
  modelType: { family: "iphone", variant: "pro" },
  runtimeId: RUNTIME,
  osVersion: "27",
  compatibility: "supported",
};
const DEVICE: BootedDevice = {
  name: "Broker iPhone",
  platform: "ios",
  deviceId: UDID,
};

function image(
  state: "Booted" | "Shutdown" | "Booting" | "Shutting Down" = "Booted",
  overrides: Partial<DeviceInfo> = {},
): DeviceInfo {
  return {
    name: DEVICE.name,
    platform: "ios",
    deviceId: UDID,
    isRunning: state === "Booted",
    state,
    isAvailable: true,
    deviceType: DEVICE_TYPE,
    runtimeId: RUNTIME,
    runtime: RUNTIME,
    osVersion: "27.0",
    iosVersion: "27.0",
    ...overrides,
  };
}

interface HarnessOptions {
  inventories?: DeviceInfo[][];
  assertOwned?: (call: number) => Promise<void>;
  stopDevice?: () => Promise<void>;
  eraseSimulator?: () => Promise<void>;
  bootSimulator?: () => Promise<BootedDevice>;
}

function harness(options: HarnessOptions = {}) {
  const events: string[] = [];
  const listOptions: unknown[] = [];
  const inventories = options.inventories ?? [[image()], [image("Shutdown")], [image()]];
  let listCall = 0;
  let ownershipCall = 0;
  const resetter = new IosBaselineReset({
    simctl: {
      listSimulatorImages: async (...args) => {
        events.push(`list:${++listCall}`);
        listOptions.push(args);
        return inventories[listCall - 1] ?? [];
      },
      eraseSimulator: async (udid) => {
        events.push(`erase:${udid}`);
        await options.eraseSimulator?.();
      },
      bootSimulator: async (udid) => {
        events.push(`boot:${udid}`);
        return (await options.bootSimulator?.()) ?? DEVICE;
      },
    },
    stopDevice: async (device) => {
      events.push(`stop:${device.deviceId}`);
      await options.stopDevice?.();
    },
  });
  const assertOwned = async () => {
    events.push(`owned:${++ownershipCall}`);
    await options.assertOwned?.(ownershipCall);
  };
  return { resetter, assertOwned, events, listOptions };
}

describe("IosBaselineReset", () => {
  test("runs the bounded clean-baseline sequence with fresh authoritative reads", async () => {
    const h = harness();

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).resolves.toBe("clean");

    expect(h.events).toEqual([
      "list:1",
      "owned:1",
      `stop:${UDID}`,
      "list:2",
      "owned:2",
      `erase:${UDID}`,
      "owned:3",
      `boot:${UDID}`,
      "list:3",
      "owned:4",
    ]);
    expect(h.listOptions).toEqual([
      [undefined, { bypassCache: true }],
      [undefined, { bypassCache: true }],
      [undefined, { bypassCache: true }],
    ]);
  });

  test("cannot erase until fresh inventory authoritatively reports Shutdown", async () => {
    const h = harness({ inventories: [[image()], [image("Shutting Down")]] });

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBeInstanceOf(
      ActionableError,
    );

    expect(h.events).toEqual(["list:1", "owned:1", `stop:${UDID}`, "list:2"]);
  });

  test("an ownership change stops before the next native mutation", async () => {
    const ownershipLost = new ActionableError("resource ownership changed");
    const h = harness({
      assertOwned: async (call) => {
        if (call === 2) {
          throw ownershipLost;
        }
      },
    });

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(ownershipLost);
    expect(h.events).toEqual(["list:1", "owned:1", `stop:${UDID}`, "list:2", "owned:2"]);
  });

  test("a final ownership change prevents a clean result", async () => {
    const ownershipLost = new ActionableError("resource ownership changed");
    const h = harness({
      assertOwned: async (call) => {
        if (call === 4) {
          throw ownershipLost;
        }
      },
    });

    await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBe(ownershipLost);
    expect(h.events.at(-1)).toBe("owned:4");
  });

  test.each([
    ["stop", { stopDevice: async () => Promise.reject(new Error("stop failed")) }],
    ["erase", { eraseSimulator: async () => Promise.reject(new Error("erase failed")) }],
    ["boot", { bootSimulator: async () => Promise.reject(new Error("boot failed")) }],
  ] satisfies Array<[string, HarnessOptions]>)(
    "%s failure does not start the following mutation",
    async (operation, options) => {
      const h = harness(options);

      await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toThrow(
        `${operation} failed`,
      );

      if (operation === "stop") {
        expect(h.events).not.toContain("list:2");
      } else if (operation === "erase") {
        expect(h.events.some((event) => event.startsWith("boot:"))).toBe(false);
      } else {
        expect(h.events).not.toContain("list:3");
      }
    },
  );

  test.each([
    ["missing target", []],
    ["duplicate target", [image(), image()]],
    ["unknown availability", [image("Booted", { isAvailable: undefined })]],
    ["partial type", [image("Booted", { deviceType: undefined })]],
    ["transitional state", [image("Booting")]],
    ["different runtime", [image("Booted", { runtimeId: `${RUNTIME}-other` })]],
    ["different type", [image("Booted", { deviceType: `${DEVICE_TYPE}-other` })]],
    ["different OS", [image("Booted", { osVersion: "28.0", iosVersion: "28.0" })]],
  ] satisfies Array<[string, DeviceInfo[]]>)(
    "rejects %s before the first native mutation",
    async (_description, inventory) => {
      const h = harness({ inventories: [inventory] });

      await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBeInstanceOf(
        ActionableError,
      );
      expect(h.events).toEqual(["list:1"]);
    },
  );

  test.each([
    ["non-Booted state", image("Shutdown")],
    ["changed runtime", image("Booted", { runtimeId: `${RUNTIME}-other` })],
    ["changed type", image("Booted", { deviceType: `${DEVICE_TYPE}-other` })],
  ] satisfies Array<[string, DeviceInfo]>)(
    "does not return clean when final inventory has %s",
    async (_description, finalImage) => {
      const h = harness({ inventories: [[image()], [image("Shutdown")], [finalImage]] });

      await expect(h.resetter.reset(DEVICE, PROFILE, h.assertOwned)).rejects.toBeInstanceOf(
        ActionableError,
      );
      expect(h.events.at(-1)).toBe("list:3");
    },
  );

  test("does not return clean before bootSimulator joins the completed boot", async () => {
    const bootEntered = Promise.withResolvers<void>();
    const finishBoot = Promise.withResolvers<BootedDevice>();
    let settled = false;
    const h = harness({
      bootSimulator: async () => {
        bootEntered.resolve();
        return finishBoot.promise;
      },
    });

    const reset = h.resetter.reset(DEVICE, PROFILE, h.assertOwned).then((result) => {
      settled = true;
      return result;
    });
    await bootEntered.promise;

    expect(settled).toBe(false);
    expect(h.events).not.toContain("list:3");

    finishBoot.resolve(DEVICE);
    await expect(reset).resolves.toBe("clean");
  });

  test("rejects a wrong boot result and invalid iOS reset inputs", async () => {
    const wrongBoot = harness({
      bootSimulator: async () => ({ ...DEVICE, deviceId: `${UDID}-other` }),
    });
    await expect(
      wrongBoot.resetter.reset(DEVICE, PROFILE, wrongBoot.assertOwned),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(wrongBoot.events).not.toContain("list:3");

    const invalidTarget = harness();
    await expect(
      invalidTarget.resetter.reset({ ...DEVICE, platform: "android" }, PROFILE, () =>
        Promise.resolve(),
      ),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(invalidTarget.events).toEqual([]);

    const duoProfile: typeof PROFILE = {
      ...PROFILE,
      archetype: "duo",
      modelType: { family: "duo", variant: "duo" },
    };
    const duo = harness();
    await expect(
      duo.resetter.reset(DEVICE, duoProfile, () => Promise.resolve()),
    ).rejects.toBeInstanceOf(ActionableError);
    expect(duo.events).toEqual([]);
  });
});
