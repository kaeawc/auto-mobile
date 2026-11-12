import type { BlePeripheralSidecarFactory } from "../../src/features/blePeripheral/BlePeripheralManager";
import { FakeBlePeripheralSidecar } from "./FakeBlePeripheralSidecar";

export class FakeBlePeripheralSidecarFactory implements BlePeripheralSidecarFactory {
  readonly created: FakeBlePeripheralSidecar[] = [];
  create(): FakeBlePeripheralSidecar {
    const sidecar = new FakeBlePeripheralSidecar();
    this.created.push(sidecar);
    return sidecar;
  }
}
