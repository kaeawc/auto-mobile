import type { reserveBootCapacity } from "../../../features/bootAdmission/sharedBootAdmissionGates";
/**
 * Assembles the broker's native-device acquisition (#11173 part b) from production parts: the
 * host-wide binding registry, the reconciler over real inventory / provisionDevice / deleteDevice /
 * pool claims, and the session manager's liveness ownership and managed-execution policy.
 */

import { freeDeviceBusyReason, type FreeDeviceBusyPool } from "./freeDeviceBusyReason";
import { RegistryBindingResourceBudget, type BindingResourceBudgetPolicy } from "./resourceBudget";
import type { DeviceInfo } from "../../../models/index";
import {
  MultiPlatformDeviceManager,
  type PlatformDeviceManager,
} from "../../../devices/deviceUtils";
import type { ForeignAndroidSerialSource } from "../../../devices/deviceDiscoveryContracts";
import type { ExactIosRuntimeCatalog } from "../../../devices/exactDeviceProvisioning";
import {
  FileAvdConfigReader,
  type AvdConfigReader,
} from "../../../utils/android-cmdline-tools/AvdConfigReader";
import {
  listDevices,
  listInstalledSystemImages,
} from "../../../utils/android-cmdline-tools/avdmanager";
import { SimCtlClient } from "../../../utils/ios-cmdline-tools/SimCtlClient";
import type { Timer } from "../../../utils/SystemTimer";
import { runAsBindingReconciler } from "./exclusion";
import { WorkflowBindingDeviceDeleter } from "./deviceDeleter";
import { BrokerDeviceAcquisition, type BrokerDeviceAcquisitionSessions } from "./deviceAcquisition";
import { DeviceManagerBindingInventory } from "./DeviceManagerBindingInventory";
import {
  GateBindingBootCapacity,
  type BindingBootCapacityAssertion,
} from "./GateBindingBootCapacity";
import { PoolBindingDeviceClaims, type BindingClaimPool } from "./PoolBindingDeviceClaims";
import { ToolBindingProvisioner, type BindingToolInvoker } from "./reconcilerPorts";
import {
  DefaultManagedSpecMatcher,
  DefaultManagedSpecResolver,
  BindingReconciler,
  type BindingDeviceProvisioner,
  type BindingDeviceDeleter,
  type ManagedAndroidImageCatalog,
  type ManagedAndroidProfileCatalog,
} from "./reconciler";
import { BindingJournalRedriveLoop } from "../registry/BindingJournalRedriveLoop";
import { type BindingJournal, type BindingJournalInFlight } from "../registry/bindingJournal";
import type {
  BindingJournalOwner,
  BindingProcessIdentity,
  BindingRegistry,
} from "../registry/bindingRegistry";
import {
  defaultBindingExecOwnerLiveness,
  withLiveExecutionSessions,
  type LiveExecutionSessions,
} from "../registry/ownerLiveness";
import { daemonToolRegistry } from "../../toolRegistryPort";

export interface DaemonBrokerDeviceAcquisitionOptions {
  registry: () => Promise<BindingRegistry>;
  sessions: BrokerDeviceAcquisitionSessions;
  pool: BindingClaimPool & FreeDeviceBusyPool & Partial<ForeignAndroidSerialSource>;
  resourceBudgetPolicy?: BindingResourceBudgetPolicy;
  /** Which sessions this daemon holds as live managed executions (#11275). */
  executions?: LiveExecutionSessions;
  owner: () => BindingProcessIdentity;
  timer: Timer;
  journal: { owner: BindingJournalOwner; inFlight: BindingJournalInFlight };
  /** Defaults to the in-process tool registry (the same handlers MCP callers run). */
  invokeTool?: BindingToolInvoker;
  /** The host device tooling behind the reconciler's ports; tests inject fakes. */
  tooling?: DaemonBindingTooling;
  /** True when released Android emulators are destroyed, not reused warm (#15477). */
  discardAndroidSnapshotOnExit?: () => boolean;
}

/** Each part defaults to the host's real tooling. */
export interface DaemonBindingTooling {
  deviceManager?: Pick<PlatformDeviceManager, "listDeviceImages"> &
    Partial<Pick<PlatformDeviceManager, "getBootedDevicesDetailed">>;
  androidConfigReader?: Pick<AvdConfigReader, "readConfig">;
  androidImageCatalog?: ManagedAndroidImageCatalog;
  androidProfileCatalog?: ManagedAndroidProfileCatalog;
  iosRuntimeCatalog?: ExactIosRuntimeCatalog;
  /** Defaults to the process-wide boot admission gates. */
  checkBootCapacity?: BindingBootCapacityAssertion;
  reserveBootCapacity?: typeof reserveBootCapacity;
  /** Native preparation port; defaults to the daemon tool workflow. */
  provisioner?: BindingDeviceProvisioner;
  /** Verified native deletion port; defaults to the daemon delete workflow. */
  deleter?: BindingDeviceDeleter;
}

const sdkAndroidImageCatalog: ManagedAndroidImageCatalog = {
  listInstalledPackages: async (signal) =>
    (await listInstalledSystemImages(undefined, undefined, signal)).map(
      (image) => image.packageName,
    ),
};

const sdkAndroidProfileCatalog: ManagedAndroidProfileCatalog = {
  listProfileIds: async (signal) =>
    (await listDevices(undefined, signal)).map((profile) => profile.id),
};

/** The injected tooling with the host's real tooling filled in. */
function hostTooling(tooling: DaemonBindingTooling = {}, source?: ForeignAndroidSerialSource) {
  return {
    deviceManager:
      tooling.deviceManager ??
      (source
        ? new MultiPlatformDeviceManager().withForeignAndroidSerialSource(source)
        : new MultiPlatformDeviceManager()),
    androidConfigReader: tooling.androidConfigReader ?? new FileAvdConfigReader(),
    androidImageCatalog: tooling.androidImageCatalog ?? sdkAndroidImageCatalog,
    androidProfileCatalog: tooling.androidProfileCatalog ?? sdkAndroidProfileCatalog,
    // The simulator catalog exists only where simctl does.
    iosRuntimeCatalog:
      tooling.iosRuntimeCatalog ??
      (process.platform === "darwin" ? new SimCtlClient(null) : undefined),
    checkBootCapacity: tooling.checkBootCapacity,
    reserveBootCapacity: tooling.reserveBootCapacity,
  };
}

/**
 * The in-process registry invoker the daemon uses by default: the same handlers MCP callers run,
 * reached through `ToolRegistry.callInternal`. Resolved lazily: the tool registry pulls in every
 * tool module. Exported so the real-handler integration test drives exactly this seam (#11266).
 */
export const defaultBindingToolInvoker: BindingToolInvoker = async (name, args, signal) => {
  return await daemonToolRegistry().callInternal(name, args, undefined, signal);
};

export interface DaemonBrokerDeviceAcquisitionHandle {
  acquisition: BrokerDeviceAcquisition;
  /**
   * Start the background journal redrive pass over `registry` (#11179). Call only once the
   * registry exists; the caller stops the returned loop on shutdown. Idempotent per registry: a
   * second call returns the running loop.
   */
  startJournalRedrive(registry: BindingRegistry): BindingJournalRedriveLoop;
  /** The binding journal over `registry` (abandoned-scope sweep, #11174), shared with acquisitions. */
  journalFor(registry: BindingRegistry): BindingJournal;
}

export function createDaemonBrokerDeviceAcquisition(
  options: DaemonBrokerDeviceAcquisitionOptions,
): DaemonBrokerDeviceAcquisitionHandle {
  const isBusy = (device: DeviceInfo) => freeDeviceBusyReason(options.pool, device);
  const invokeTool = options.invokeTool ?? defaultBindingToolInvoker;
  const reconcilers = new WeakMap<BindingRegistry, BindingReconciler>();
  const redriveLoops = new WeakMap<BindingRegistry, BindingJournalRedriveLoop>();
  const reconcilerFor = (registry: BindingRegistry): BindingReconciler => {
    let reconciler = reconcilers.get(registry);
    if (!reconciler) {
      // Built on the first acquisition: daemons that never serve a binding never touch them.
      const tooling = hostTooling(
        options.tooling,
        options.pool.foreignSerials
          ? { foreignSerials: (serials, signal) => options.pool.foreignSerials!(serials, signal) }
          : undefined,
      );
      const { deviceManager, androidConfigReader } = tooling;
      const inventory = new DeviceManagerBindingInventory(deviceManager);
      const claims = new PoolBindingDeviceClaims(options.pool, options.executions);
      const resourceBudget = options.resourceBudgetPolicy
        ? new RegistryBindingResourceBudget({
            registry: async () => registry,
            policy: options.resourceBudgetPolicy,
            inventory,
            timer: options.timer,
          })
        : undefined;
      reconciler = new BindingReconciler({
        registry,
        inventory,
        ...(resourceBudget ? { resourceBudget } : {}),
        isBusy,
        matcher: new DefaultManagedSpecMatcher(androidConfigReader),
        resolver: new DefaultManagedSpecResolver(tooling.iosRuntimeCatalog, {
          androidImageCatalog: tooling.androidImageCatalog,
          androidProfileCatalog: tooling.androidProfileCatalog,
        }),
        provisioner:
          options.tooling?.provisioner ??
          new ToolBindingProvisioner({
            invokeTool,
            deviceManager,
            androidConfigReader,
            timer: options.timer,
            releaseSession: (sessionUuid) => options.sessions.releaseSession(sessionUuid),
            discardAndroidSnapshotOnExit: options.discardAndroidSnapshotOnExit,
          }),
        // The verified delete workflow run as the daemon (#11178): a journaled delete of an idle or
        // abandoned binding's device has no execution session for the tool-level ownership check.
        deleter: options.tooling?.deleter ?? new WorkflowBindingDeviceDeleter(options.timer),
        claims,
        // A binding whose recorded owner died with a restart stays in use while its session lives.
        ...(options.executions
          ? {
              isExecOwnerLive: withLiveExecutionSessions(
                defaultBindingExecOwnerLiveness,
                options.executions,
              ),
            }
          : {}),
        // Replacement reserves in the shared boot ledger before deletion, then transfers the slot
        // to the provision-path boot. Fresh creates retain their read-only preflight.
        capacity: new GateBindingBootCapacity(
          options.timer,
          tooling.checkBootCapacity,
          tooling.reserveBootCapacity,
        ),
        timer: options.timer,
        journal: { owner: options.journal.owner, inFlight: options.journal.inFlight },
      });
      reconcilers.set(registry, reconciler);
    }
    return reconciler;
  };
  const acquisition = new BrokerDeviceAcquisition({
    registry: options.registry,
    // The reconciler holds no execution session while it provisions or deletes, so it runs as
    // this binding's reconciler, which the generic-exclusion guard accepts for this binding only.
    reconcile: (registry, request) =>
      runAsBindingReconciler(request.key, () => reconcilerFor(registry).reconcile(request)),
    sessions: options.sessions,
    owner: options.owner,
    timer: options.timer,
  });
  return {
    acquisition,
    startJournalRedrive: (registry) => {
      // Single-flight per registry: every open site may ask, only the first starts a loop (#11338).
      let loop = redriveLoops.get(registry);
      if (!loop) {
        loop = new BindingJournalRedriveLoop(reconcilerFor(registry).journal, options.timer);
        redriveLoops.set(registry, loop);
        loop.start();
      }
      return loop;
    },
    journalFor: (registry) => reconcilerFor(registry).journal,
  };
}
