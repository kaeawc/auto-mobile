import { BlePeripheralManager } from "../../src/features/blePeripheral/BlePeripheralManager";
import { blePeripheralSchema } from "../../src/features/blePeripheral/blePeripheralSchema";
import { FakeBlePeripheralSidecarFactory } from "../fakes/FakeBlePeripheralSidecarFactory";
import { FakePythonEnvProvisioner } from "../fakes/FakePythonEnvProvisioner";
import { FakeBleTransportResolver } from "../fakes/FakeBleTransportResolver";
import { FakeIdGenerator } from "../fakes/FakeIdGenerator";

export const bleStartArgs = () =>
  blePeripheralSchema.parse({
    action: "start",
    name: "Prototype",
    presets: ["battery", "heartRate"],
    deviceId: "emulator-5554",
  });

export function blePeripheralFixture() {
  const sidecars = new FakeBlePeripheralSidecarFactory();
  const environments = new FakePythonEnvProvisioner();
  const transports = new FakeBleTransportResolver();
  const manager = new BlePeripheralManager({
    sidecars,
    environments,
    transports,
    ids: new FakeIdGenerator(),
  });
  return { sidecars, environments, transports, manager };
}
