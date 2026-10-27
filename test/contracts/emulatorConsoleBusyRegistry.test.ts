import { InMemoryEmulatorConsoleBusyRegistry } from "../../src/utils/android-cmdline-tools/EmulatorConsoleBusyRegistry";
import { FakeEmulatorConsoleBusyRegistry } from "../fakes/FakeEmulatorConsoleBusyRegistry";
import { runEmulatorConsoleBusyRegistryContract } from "./EmulatorConsoleBusyRegistryContract";

runEmulatorConsoleBusyRegistryContract(
  "FakeEmulatorConsoleBusyRegistry",
  () => new FakeEmulatorConsoleBusyRegistry(),
);
runEmulatorConsoleBusyRegistryContract(
  "InMemoryEmulatorConsoleBusyRegistry",
  () => new InMemoryEmulatorConsoleBusyRegistry(),
);
