import type { NetsimBleTransportResolver } from "../../src/features/blePeripheral/BleTransportResolver";
import type {
  EmulatorProcessTableSource,
  EmulatorHostProcessRow,
} from "../../src/utils/android-cmdline-tools/EmulatorProcessStop";
import type {
  EmulatorGrpcDiscovery,
  EmulatorGrpcEndpoint,
} from "../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";

type BleTransportSources = ConstructorParameters<typeof NetsimBleTransportResolver>[0];

export class FakeBleTransportSources implements BleTransportSources {
  rows: EmulatorHostProcessRow[] = [];
  advertised?: EmulatorGrpcEndpoint;
  incomplete = false;
  reads = 0;
  readonly processes: EmulatorProcessTableSource = {
    read: async () => {
      this.reads++;
      return { value: this.rows, incomplete: this.incomplete };
    },
  };
  readonly discovery: EmulatorGrpcDiscovery = { findByConsolePort: async () => this.advertised };
}
