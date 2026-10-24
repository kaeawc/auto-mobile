import { templateName } from "../../../src/utils/ios-cmdline-tools/SimulatorTemplateKey";
import { expect, test } from "bun:test";
import { DefaultDeviceProvisioner } from "../../../src/devices/deviceProvisioning";
import { DefaultExactDeviceProvisioner } from "../../../src/devices/exactDeviceProvisioning";
import { FakeAndroidAvdCreator, FakeIosSimulatorCreator } from "../../fakes/FakeDeviceProvisioner";
import { FakeVirtualDeviceLifecycleCoordinator } from "../../fakes/FakeVirtualDeviceLifecycleCoordinator";
import { FakeTimer } from "../../fakes/FakeTimer";
import { SimulatorTemplatesHarness } from "../../helpers/SimulatorTemplatesHarness";
const deviceType = {
  name: "iPhone",
  identifier: "phone",
  productFamily: "iPhone",
  bundlePath: "",
  minRuntimeVersion: 0,
  maxRuntimeVersion: 0,
};
test("matcher creation binds clone before applying its profile and returning", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  const runtime = "com.apple.CoreSimulator.SimRuntime.iOS-27-0";
  fake.manifest!.key.runtime = runtime;
  const list = fake.client.listSimulators;
  fake.client.listSimulators = async () => {
    const rows = await list();
    for (const row of Object.values(rows.devices).flat()) {
      row.name = templateName(fake.manifest!.key);
    }
    return rows;
  };
  const getRuntimes = fake.client.getCatalogChecked;
  fake.client.getCatalogChecked = async () => ({
    ...(await getRuntimes()),
    runtimes: (await getRuntimes()).runtimes.map((entry) => ({ ...entry, identifier: runtime })),
  });
  const events: string[] = [];
  const provisioner = new DefaultDeviceProvisioner({
    iosCreator: () => new FakeIosSimulatorCreator([deviceType], runtime),
    androidCreator: () => new FakeAndroidAvdCreator(),
    simulatorCreation: fake.service(),
    identityHooks: {
      reserveBeforeCreate: async () => undefined,
      bindAfterCreate: async (device) => {
        events.push(`bind:${device.deviceId}`);
      },
    },
    prebootProfile: {
      apply: async (udid) => {
        events.push(`apply:${udid}`);
        return { applied: true, labels: [] };
      },
    },
  });
  expect((await provisioner.provision({ platform: "ios" })).deviceId).toBe("cloned");
  expect(events).toEqual(["bind:cloned", "apply:cloned"]);
});
test("exact creation reapplies explicit resources to clone UDID before return", async () => {
  const fake = new SimulatorTemplatesHarness();
  fake.ready();
  const events: string[] = [];
  const provisioner = new DefaultExactDeviceProvisioner({
    timer: new FakeTimer(),
    lifecycleCoordinator: new FakeVirtualDeviceLifecycleCoordinator(),
    listDeviceImages: async () => [],
    isCreationAllowed: () => true,
    avdManager: { createAvd: async () => ({ success: true, message: "" }) },
    androidConfigReader: { readConfig: async () => null },
    androidConfigWriter: { setMemoryMb: async () => {} },
    iosSimulator: fake.client,
    simulatorCreation: fake.service(),
    prebootProfile: {
      apply: async (udid, options) => {
        expect(options.resources).toEqual({ widgets: "disabled" });
        events.push(`apply:${udid}`);
        return { applied: true, labels: [] };
      },
    },
  });
  const result = await provisioner.provision({
    platform: "ios",
    name: "work",
    spec: { runtime: "ios", deviceType: "phone" },
    resources: { widgets: "disabled" },
  });
  expect(result.device.deviceId).toBe("cloned");
  expect(events).toEqual(["apply:cloned"]);
});
