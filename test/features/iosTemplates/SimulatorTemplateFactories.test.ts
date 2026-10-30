import { FakeTimer } from "../../fakes/FakeTimer";
import { FakeVirtualDeviceLifecycleCoordinator } from "../../fakes/FakeVirtualDeviceLifecycleCoordinator";
import { expect, test } from "bun:test";
import { createDefaultDeviceProvisioner } from "../../../src/devices/deviceProvisioning";
import { createDefaultExactDeviceProvisioner } from "../../../src/devices/exactDeviceProvisioning";
import { getDefaultSimulatorCreationService } from "../../../src/features/iosTemplates/defaultSimulatorCreationService";
import { SimulatorCreationService } from "../../../src/features/iosTemplates/SimulatorCreationService";
import { FakeDeviceManager } from "../../fakes/FakeDeviceManager";
import { FakeIosSimulatorCreator } from "../../fakes/FakeDeviceProvisioner";
const type = {
  name: "iPhone",
  identifier: "phone",
  productFamily: "iPhone",
  bundlePath: "",
  minRuntimeVersion: 0,
  maxRuntimeVersion: 0,
};
test("production factories with disabled service resolve no template dependencies", async () => {
  const creator = new FakeIosSimulatorCreator([type]);
  const service = new SimulatorCreationService(
    creator,
    () => false,
    () => {
      throw new Error("disabled template dependencies");
    },
  );
  const provisioner = createDefaultDeviceProvisioner(() => creator, undefined, service);
  await provisioner.provision({ platform: "ios" });
  expect(creator.createCalls).toHaveLength(1);
  const exact = createDefaultExactDeviceProvisioner(
    new FakeDeviceManager(),
    { isCreationAllowed: () => true, describeSource: () => "test" },
    {
      simulatorCreation: service,
      ios: {
        iosSimulator: creator,
        iosRuntimeCatalog: undefined,
        timer: new FakeTimer(),
        lifecycleCoordinator: new FakeVirtualDeviceLifecycleCoordinator(),
        prebootProfile: { apply: async () => ({ applied: true, resources: [], labels: [] }) },
      },
    },
  );
  await exact.provision({
    platform: "ios",
    name: "exact",
    spec: { deviceType: "phone", runtime: "ios" },
  });
  expect(creator.createCalls).toHaveLength(2);
});
test("injected narrow creator never resolves real template clients regardless of exported flag", async () => {
  const creator = new FakeIosSimulatorCreator();
  const service = getDefaultSimulatorCreationService(() => creator);
  expect(await service.create({ name: "work", runtime: "ios", deviceType: "phone" })).toEqual({
    udid: "CREATED-UDID",
    source: "create",
  });
  expect(creator.createCalls).toHaveLength(1);
  expect(getDefaultSimulatorCreationService()).toBe(getDefaultSimulatorCreationService());
});
