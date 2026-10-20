import { describe, expect, test } from "bun:test";
import {
  DeviceReadiness,
  type DeviceClientSimctl,
} from "../../../src/daemon/readiness/DeviceReadiness";
import { RegistryBindingExclusion } from "../../../src/daemon/sessionBroker/provisioning/exclusion";
import { InMemoryVirtualDeviceLifecycleCoordinator } from "../../../src/devices/virtualDeviceLifecycleCoordinator";
import {
  ActionableError,
  type BootedDevice,
  type DeviceInfo,
  type Platform,
} from "../../../src/models";
import type { IosBootInstrumentation } from "../../../src/models/IosBootInstrumentation";
import { permissiveDeviceAdmissionGate } from "../../../src/utils/deviceAdmissionGate";
import { FakeAdbClientFactory } from "../../fakes/FakeAdbClientFactory";
import { FakeAdbExecutor } from "../../fakes/FakeAdbExecutor";
import { FakeBindingRegistry } from "../../fakes/FakeBindingRegistry";
import { FakeDeviceClientProvider } from "../../fakes/FakeDeviceClientProvider";
import { FakeDeviceUtils } from "../../fakes/FakeDeviceUtils";
import { FakeSimctl } from "../../fakes/FakeSimctl";
import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeWindow } from "../../fakes/FakeWindow";
import { assignBindingDevice } from "../sessionBroker/provisioning/bindingFixtures";

const iosBootInstrumentation: IosBootInstrumentation = {
  run: async (request, boot) => await boot(request.timeoutMs),
};

class ReadinessSimctl extends FakeSimctl implements DeviceClientSimctl {
  override async presentSimulatorAfterStart(): Promise<void> {}
}

function image(platform: Platform, name: string, deviceId: string): DeviceInfo {
  return { platform, name, deviceId, isRunning: false, isAvailable: true, state: "Shutdown" };
}

function harness(platform: Platform, images: DeviceInfo[], booted: BootedDevice[] = []) {
  const timer = new FakeTimer();
  const registry = new FakeBindingRegistry(timer);
  let registryReads = 0;
  let registryError: Error | undefined;
  const bindingExclusion = new RegistryBindingExclusion(async () => {
    registryReads++;
    if (registryError) {
      throw registryError;
    }
    return registry;
  }, timer);
  const simctl = new ReadinessSimctl();
  simctl.setAvailableSimulators(images);
  simctl.setBootedSimulators(booted);
  for (const candidate of [...images, ...booted]) {
    simctl.setDeviceInfo(candidate.deviceId!, {
      udid: candidate.deviceId!,
      name: candidate.name,
      isAvailable: true,
      state: "Booted",
    });
  }
  const deviceUtils = new FakeDeviceUtils();
  deviceUtils.setDeviceImages(platform, images);
  deviceUtils.setBootedDevices(platform, booted);
  for (const candidate of images) {
    deviceUtils.setMockChildProcess(candidate.name, null);
  }
  const adb = new FakeAdbExecutor();
  adb.setDevices([
    ...images.map((candidate) => ({ ...candidate, deviceId: candidate.deviceId! })),
    ...booted,
  ]);
  const window = new FakeWindow();
  window.configureActiveWindow({ appId: "com.example", activityName: "Main", layoutSeqSum: 0 });
  const readiness = DeviceReadiness.createInstance(
    new FakeDeviceClientProvider(adb, deviceUtils, simctl, { window }),
    new FakeAdbClientFactory(adb),
    {
      bindingExclusion,
      runnerReadinessTimer: timer,
      lifecycleCoordinator: new InMemoryVirtualDeviceLifecycleCoordinator(timer),
      admissionGate: permissiveDeviceAdmissionGate,
      iosBootInstrumentation,
    },
  );
  return {
    registry,
    bindingExclusion,
    find: () => readiness.findOrStartDevice(platform, { readiness: "booted" }),
    bootCalls: () =>
      platform === "ios"
        ? simctl.getMethodCalls("bootSimulator").map((call) => call.udid)
        : deviceUtils.getExecutedOperations().filter((call) => call.startsWith("startDevice:")),
    registryReads: () => registryReads,
    failRegistry: () => {
      registryError = new Error("registry unavailable");
    },
  };
}

describe.each(["ios", "android"] as const)("%s implicit readiness auto-start", (platform) => {
  test.each(["ambroker-a", "amslot-a"])("skips %s even when it is first", async (name) => {
    const broker = image(platform, name, "AAAA");
    const plain = image(platform, "plain", "BBBB");
    // iOS must sort by UDID; Android must skip the first listed AVD.
    const h = harness(platform, platform === "ios" ? [plain, broker] : [broker, plain]);
    expect((await h.find()).deviceId).toBe("BBBB");
    expect(h.bootCalls()).toEqual(platform === "ios" ? ["BBBB"] : ["startDevice:plain:default"]);
    expect(h.registryReads()).toBe(1);
  });

  test("only broker images refuse with an actionable error and no boot", async () => {
    const h = harness(platform, [
      image(platform, "ambroker-a", "AAAA"),
      image(platform, "amslot-b", "BBBB"),
    ]);
    const error = await h.find().catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(ActionableError);
    if (!(error instanceof ActionableError)) {
      throw new Error("expected actionable auto-start refusal");
    }
    expect(error.message).toContain("broker-managed or held by a binding");
    expect(error.message).toContain("deviceId");
    expect(error.message).toContain("start a non-broker device");
    expect(h.bootCalls()).toEqual([]);
  });

  test.each(["name", "deviceId"] as const)(
    "skips a binding-held image by %s after refreshing",
    async (identity) => {
      const held = image(platform, "ordinary-held", "AAAA");
      const h = harness(platform, [held, image(platform, "plain", "BBBB")]);
      await h.bindingExclusion.refresh();
      await assignBindingDevice(h.registry, platform, held[identity]!);
      expect((await h.find()).deviceId).toBe("BBBB");
      expect(h.bootCalls()).toEqual(platform === "ios" ? ["BBBB"] : ["startDevice:plain:default"]);
    },
  );

  test("only binding-held images refuse without booting", async () => {
    const h = harness(platform, [image(platform, "ordinary-held", "AAAA")]);
    await assignBindingDevice(h.registry, platform, "AAAA");
    await expect(h.find()).rejects.toThrow(ActionableError);
    expect(h.bootCalls()).toEqual([]);
  });

  test("an unreadable registry refuses before any boot", async () => {
    const h = harness(platform, [image(platform, "plain", "AAAA")]);
    h.failRegistry();
    await expect(h.find()).rejects.toThrow("registry");
    expect(h.bootCalls()).toEqual([]);
  });

  test("already booted broker and binding-held devices keep their selection path", async () => {
    const booted: BootedDevice = { platform, name: "ambroker-running", deviceId: "AAAA" };
    const h = harness(platform, [image(platform, booted.name, booted.deviceId)], [booted]);
    await assignBindingDevice(h.registry, platform, booted.deviceId);
    h.failRegistry();
    expect(await h.find()).toEqual(booted);
    expect(h.registryReads()).toBe(0);
    expect(h.bootCalls()).toEqual([]);
  });
});
