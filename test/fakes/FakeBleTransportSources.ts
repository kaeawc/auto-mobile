import type {
  EmulatorProcessTableSource,
  EmulatorHostProcessRow,
} from "../../src/utils/android-cmdline-tools/EmulatorProcessStop";
import type {
  EmulatorGrpcDiscovery,
  EmulatorGrpcEndpoint,
} from "../../src/utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";

export class FakeBleTransportSources {
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
