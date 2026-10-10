/**
 * Assembles the daemon's `daemon/acquireManagedSlots` (#11173 part b) from production parts: the
 * host-wide slot registry, the reconciler over real inventory / provisionDevice / deleteDevice /
 * pool claims, and the session manager's liveness ownership and managed-execution policy.
 */

import { MultiPlatformDeviceManager } from "../../devices/deviceUtils";
import { FileAvdConfigReader } from "../../utils/android-cmdline-tools/AvdConfigReader";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import type { Timer } from "../../utils/SystemTimer";
import { runAsManagedSlotReconciler } from "./managedSlotExclusion";
import { WorkflowManagedSlotDeviceDeleter } from "../../server/managedSlotDeviceDeleter";
import {
  ManagedSlotAcquisition,
  type ManagedSlotAcquisitionDependencies,
  type ManagedSlotAcquisitionSessions,
} from "./managedSlotAcquisition";
import {
  DeviceManagerSlotInventory,
  PoolManagedSlotDeviceClaims,
  ToolManagedSlotProvisioner,
  type ManagedSlotClaimPool,
  type ManagedSlotToolInvoker,
} from "./managedSlotReconcilerPorts";
import {
  DefaultManagedSpecMatcher,
  DefaultManagedSpecResolver,
  ManagedSlotReconciler,
} from "./reconciler";
import {
  SlotJournalRedriveLoop,
  type ManagedSlotJournal,
  type SlotJournalInFlight,
} from "./slotJournal";
import type { SlotJournalOwner, SlotProcessIdentity, SlotRegistry } from "./slotRegistry";

export interface DaemonManagedSlotAcquisitionOptions {
  registry: () => Promise<SlotRegistry>;
  sessions: ManagedSlotAcquisitionSessions;
  pool: ManagedSlotClaimPool;
  owner: () => SlotProcessIdentity;
  timer: Timer;
  /**
   * The daemon's journal identity and the in-flight set it shares with the drain (#11179), so one
   * process never drives a journal entry twice.
   */
  journal: { owner: SlotJournalOwner; inFlight: SlotJournalInFlight };
  /** Defaults to the in-process tool registry (the same handlers MCP callers run). */
  invokeTool?: ManagedSlotToolInvoker;
  /** The settle-waiting implicit reset of a superseded incarnation (#11174). */
  resetSupersededScope?: ManagedSlotAcquisitionDependencies["resetSupersededScope"];
}

/** Resolved lazily: the tool registry pulls in every tool module. */
const defaultInvokeTool: ManagedSlotToolInvoker = async (name, args, signal) => {
  const { ToolRegistry } = await import("../../server/toolRegistry");
  return await ToolRegistry.callInternal(name, args, undefined, signal);
};

export interface DaemonManagedSlotAcquisitionHandle {
  acquisition: ManagedSlotAcquisition;
  /**
   * Start the background journal redrive pass over `registry` (#11179). Call only once the
   * registry exists; the caller stops the returned loop on shutdown.
   */
  startJournalRedrive(registry: SlotRegistry): SlotJournalRedriveLoop;
  /** The slot journal over `registry` (abandoned-scope sweep, #11174), shared with acquisitions. */
  journalFor(registry: SlotRegistry): ManagedSlotJournal;
}

export function createDaemonManagedSlotAcquisition(
  options: DaemonManagedSlotAcquisitionOptions,
): DaemonManagedSlotAcquisitionHandle {
  const invokeTool = options.invokeTool ?? defaultInvokeTool;
  const reconcilers = new WeakMap<SlotRegistry, ManagedSlotReconciler>();
  const reconcilerFor = (registry: SlotRegistry): ManagedSlotReconciler => {
    let reconciler = reconcilers.get(registry);
    if (!reconciler) {
      // Built on the first acquisition: daemons that never serve a managed slot never touch them.
      const deviceManager = new MultiPlatformDeviceManager();
      const androidConfigReader = new FileAvdConfigReader();
      reconciler = new ManagedSlotReconciler({
        registry,
        inventory: new DeviceManagerSlotInventory(deviceManager),
        matcher: new DefaultManagedSpecMatcher(androidConfigReader),
        // The simulator catalog exists only where simctl does.
        resolver: new DefaultManagedSpecResolver(
          process.platform === "darwin" ? new SimCtlClient(null) : undefined,
        ),
        provisioner: new ToolManagedSlotProvisioner({
          invokeTool,
          deviceManager,
          androidConfigReader,
          timer: options.timer,
          releaseSession: (sessionUuid) => options.sessions.releaseSession(sessionUuid),
        }),
        // The verified delete workflow run as the daemon (#11178): a journaled delete of an idle or
        // abandoned slot's device has no execution session for the tool-level ownership check.
        deleter: new WorkflowManagedSlotDeviceDeleter(options.timer),
        claims: new PoolManagedSlotDeviceClaims(options.pool),
        // Boot capacity is enforced by the provision path itself (BootCapacityExhaustedError).
        timer: options.timer,
        journal: { owner: options.journal.owner, inFlight: options.journal.inFlight },
      });
      reconcilers.set(registry, reconciler);
    }
    return reconciler;
  };
  const acquisition = new ManagedSlotAcquisition({
    registry: options.registry,
    // The reconciler holds no execution session while it provisions or deletes, so it runs as
    // this slot's reconciler, which the generic-exclusion guard accepts for this slot only.
    reconcile: (registry, request) =>
      runAsManagedSlotReconciler(request.key, () => reconcilerFor(registry).reconcile(request)),
    sessions: options.sessions,
    owner: options.owner,
    timer: options.timer,
    ...(options.resetSupersededScope ? { resetSupersededScope: options.resetSupersededScope } : {}),
  });
  return {
    acquisition,
    startJournalRedrive: (registry) => {
      const loop = new SlotJournalRedriveLoop(reconcilerFor(registry).journal, options.timer);
      loop.start();
      return loop;
    },
    journalFor: (registry) => reconcilerFor(registry).journal,
  };
}
