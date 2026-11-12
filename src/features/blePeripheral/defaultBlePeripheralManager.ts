import { ProcessTableReader } from "../../devices/bootAdmission/processTableRetry";
import { nodeProcFs } from "../../devices/bootAdmission/procProcessTable";
import { FileEmulatorGrpcDiscovery } from "../../utils/android-cmdline-tools/emulatorGrpc/emulatorGrpcDiscovery";
import { DefaultFileSystem } from "../../utils/filesystem/DefaultFileSystem";
import { DefaultHostCommandExecutor } from "../../utils/HostCommandExecutor";
import { defaultIdGenerator } from "../../utils/IdGenerator";
import { defaultTimer } from "../../utils/SystemTimer";
import { BlePeripheralManager } from "./BlePeripheralManager";
import { NetsimBleTransportResolver } from "./BleTransportResolver";
import { ManagedPythonEnvProvisioner } from "./PythonEnvProvisioner";
import { ProcessBlePeripheralSidecar } from "./ProcessBlePeripheralSidecar";

const commands = new DefaultHostCommandExecutor();
const files = new DefaultFileSystem();

/** Construction is tool-free; provisioning happens only on the first start. */
export const defaultBlePeripheralManager = new BlePeripheralManager({
  environments: new ManagedPythonEnvProvisioner({ commands, files }),
  transports: new NetsimBleTransportResolver({
    processes: new ProcessTableReader(commands, {
      timer: defaultTimer,
      processTableSupported: process.platform !== "win32",
      procFs: process.platform === "linux" ? nodeProcFs : undefined,
    }),
    discovery: new FileEmulatorGrpcDiscovery(files),
  }),
  sidecars: {
    create: () => new ProcessBlePeripheralSidecar({ spawner: commands, timer: defaultTimer }),
  },
  ids: defaultIdGenerator,
});
