import { ActionableError } from "../../models/ActionableError";
import type { IosSimulatorCreator } from "../../devices/deviceProvisioning";
import type { SimulatorCreator } from "../../devices/SimulatorCreator";
import { TemplateSimCtlClient } from "./TemplateSimCtlClient";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import {
  SimulatorPrebootProfile,
  resolveDefaultPrebootProfile,
} from "../../utils/ios-cmdline-tools/SimulatorPrebootProfile";
import { resolveTemplateCloneEnabled } from "../../utils/ios-cmdline-tools/SimulatorTemplateKey";
import { defaultTimer } from "../../utils/SystemTimer";
import { runWithAbortSignal } from "../../utils/AbortContext";
import { getSharedBootAdmissionGates } from "../bootAdmission/sharedBootAdmissionGates";
import { createDefaultIosBootInstrumentation } from "../iosSimFleet/defaultIosBootInstrumentation";
import { IosSimFleetCostCollector } from "../iosSimFleet/FleetCostCollector";
import { CommandFleetHostSource } from "../iosSimFleet/FleetHostSource";
import { DefaultHostCommandExecutor } from "../../utils/HostCommandExecutor";
import {
  SimulatorCreationService,
  type TemplateCreationDependencies,
} from "./SimulatorCreationService";
import { FileSimulatorTemplateManifestStore } from "./FileSimulatorTemplateManifestStore";
import { FileSimulatorTemplateLock } from "./SimulatorTemplateLock";
import { CommandXcodeVersionReader } from "./XcodeVersionReader";
import { SimulatorTemplateBuilder } from "./SimulatorTemplateBuilder";
import { FleetSettleDetector } from "./SettleDetector";
import { SimulatorTemplateCleanup } from "./SimulatorTemplateCleanup";
const dependencies = new WeakMap<SimCtlClient, TemplateCreationDependencies>();
const defaultXcode = new CommandXcodeVersionReader();
let defaultClient: SimCtlClient | undefined;
const defaultSimctl = () => (defaultClient ??= new SimCtlClient(null));
export function getDefaultTemplateDependencies(
  simctl = defaultSimctl(),
): TemplateCreationDependencies {
  const existing = dependencies.get(simctl);
  if (existing) {
    return existing;
  }
  const client = new TemplateSimCtlClient(simctl);
  const timer = defaultTimer;
  const store = new FileSimulatorTemplateManifestStore();
  const lock = new FileSimulatorTemplateLock(timer);
  const xcode = defaultXcode;
  const gates = getSharedBootAdmissionGates();
  const instrumentation = createDefaultIosBootInstrumentation({
    timer,
    gate: gates.ios,
    history: gates.iosBootHistory,
  });
  const source = new IosSimFleetCostCollector(
    new CommandFleetHostSource(new DefaultHostCommandExecutor(), timer, undefined, simctl),
    gates.iosBootHistory,
    timer,
  );
  const builder = new SimulatorTemplateBuilder({
    client,
    timer,
    store,
    lock,
    xcode,
    instrumentation,
    hasSpareCapacity: async () =>
      !gates.ios || (await gates.ios.evaluateBoot()).outcome === "allow",
    settle: new FleetSettleDetector(source, timer),
    profile: (key) => new SimulatorPrebootProfile(undefined, () => key.profile),
  });
  const deps: TemplateCreationDependencies = {
    client,
    store,
    lock,
    xcode,
    timer,
    profile: () => resolveDefaultPrebootProfile(process.env),
    builder: {
      build: (key, signal) => runWithAbortSignal(signal, () => builder.build(key, signal)),
    },
  };
  dependencies.set(simctl, deps);
  return deps;
}
export function createTemplateMaintenance(): {
  dependencies: TemplateCreationDependencies;
  cleanup: SimulatorTemplateCleanup;
} {
  const deps = getDefaultTemplateDependencies();
  return {
    dependencies: deps,
    cleanup: new SimulatorTemplateCleanup(deps.client, deps.store, deps.lock, async (manifest) => {
      const xcode = await deps.xcode.readBuild();
      if (xcode === "unknown") {
        return false;
      }
      const { runtimes } = await deps.client.getCatalogChecked();
      const runtime = runtimes.find((entry) => entry.identifier === manifest.key.runtime);
      return manifest.xcodeBuild !== xcode || manifest.runtimeBuild !== runtime?.buildversion;
    }),
  };
}
let service: SimulatorCreationService | undefined;
export function getDefaultSimulatorCreationService(
  simctl?: () => IosSimulatorCreator | undefined,
): SimulatorCreator {
  service ??= new SimulatorCreationService(
    { createSimulator: (...args) => defaultSimctl().createSimulator(...args) },
    () => resolveTemplateCloneEnabled(process.env),
    getDefaultTemplateDependencies,
  );
  const shared = service;
  return simctl
    ? {
        create: (request) => {
          const client = simctl();
          if (!client) {
            throw new ActionableError("iOS simulator creation is unavailable");
          }
          // Narrow injected creators cannot support template operations; never resolve host defaults.
          if (!(client instanceof SimCtlClient)) {
            return client
              .createSimulator(request.name, request.deviceType, request.runtime, request.signal)
              .then((udid) => ({ udid, source: "create" as const }));
          }
          return shared.create(request, {
            creator: client,
            dependencies: () => getDefaultTemplateDependencies(client),
          });
        },
      }
    : shared;
}

export async function stopTemplateBuilds(): Promise<void> {
  await service?.stop();
}
