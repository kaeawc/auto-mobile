import type { SimulatorPrebootProfile } from "./SimulatorPrebootProfile";
import type {
  HostChildProcess as ChildProcess,
  HostSpawnOptions as SpawnOptions,
} from "../HostCommandExecutor";
import type { IdGenerator } from "../IdGenerator";
import {
  defaultDiscoveryObservationSequence,
  type DiscoveryObservationSequence,
} from "../DiscoveryObservationSequence";
import type { Timer } from "../SystemTimer";
import type { PlistReader } from "./PlistClient";
import type { SimCtlBootOptions, SimCtlFileSystem } from "./SimCtlClient";
import type { SimulatorAppPresenter } from "./SimulatorAppPresenter";
import type { SimulatorDeviceTypeProfileSource } from "./SimulatorDeviceTypeProfiles";

/** Optional collaborators for {@link SimCtlClient}; each defaults to the production one. */
export interface SimCtlClientDependencies {
  prebootProfile?: Pick<SimulatorPrebootProfile, "removeHostState">;
  timer?: Timer;
  platform?: NodeJS.Platform;
  spawnProcess?: (command: string, args: string[], options?: SpawnOptions) => ChildProcess;
  fileSystem?: SimCtlFileSystem;
  bootOptions?: SimCtlBootOptions;
  plist?: PlistReader;
  observationSequence?: DiscoveryObservationSequence;
  deviceTypeProfiles?: SimulatorDeviceTypeProfileSource;
  simulatorAppPresenter?: SimulatorAppPresenter;
  idGenerator?: IdGenerator;
}

export function resolveSimCtlObservationSequence(
  dependencies: SimCtlClientDependencies,
): DiscoveryObservationSequence {
  return dependencies.observationSequence ?? defaultDiscoveryObservationSequence;
}
