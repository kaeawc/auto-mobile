import type { DeviceClaimMirrorHub } from "../deviceClaimMirrorHub";
import type { DaemonDeviceSessionStore } from "../daemonDependencies";
import type {
  DaemonCoreServices,
  DaemonIdentityState,
  DaemonLifecycleState,
} from "./DaemonCoreState";
import { lazySessionReleasePool } from "../releaseSessionAndDevice";
import { ActionableError } from "../../models/ActionableError";
import { logger } from "../../utils/logger";
import { MultiPlatformDeviceManager } from "../../devices/deviceUtils";
import {
  BrokerExecutionRelease,
  managedExecutionSessionsFrom,
} from "../sessionBroker/provisioning/executionRelease";
import {
  currentBindingOwnerProcess,
  defaultBindingExecOwnerLiveness,
  withLiveExecutionSessions,
} from "../sessionBroker/registry/ownerLiveness";
import {
  openSqliteBindingRegistry,
  bindingRegistryFileExists,
  type SqliteBindingRegistry,
} from "../sessionBroker/registry/sqliteBindingRegistry";
import {
  openSessionBrokerService,
  type OpenSessionBrokerServiceOptions,
  type SessionBrokerService,
} from "../sessionBroker/service";
import {
  discardsAndroidSnapshotOnExit,
  readSessionBrokerHostConfig,
  type SessionBrokerHostConfig,
} from "../sessionBroker/hostConfig";
import { ManagedExecutionReowner } from "../sessionBroker/provisioning/executionReowner";
import {
  createDaemonBrokerDeviceAcquisition,
  type DaemonBrokerDeviceAcquisitionHandle,
} from "../sessionBroker/provisioning/daemonDeviceAcquisition";
import type {
  BindingExecOwnerLiveness,
  BindingJournalOwner,
} from "../sessionBroker/registry/bindingRegistry";
import { BindingJournalInFlight } from "../sessionBroker/registry/bindingJournal";
import type { BindingJournalRedriveLoop } from "../sessionBroker/registry/BindingJournalRedriveLoop";
import { executionTracker } from "../executionTracker";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { LegacySlotDeviceRetirement } from "../sessionBroker/registry/legacySlotDeviceRetirement";
import { ProcessTableReader } from "../../devices/bootAdmission/processTableRetry";
import { nodeProcFs } from "../../features/bootAdmission/procProcessTable";
import { DefaultHostCommandExecutor } from "../../utils/HostCommandExecutor";
import { PlatformLegacySlotDeviceStopper } from "../sessionBroker/registry/platformLegacySlotDeviceStopper";
import { sessionDisposition } from "../sessionBroker/sessionDisposition";
import { errorMessage } from "../../utils/describeUnknownError";
import { AMBIENT_ENV, readEnvRaw } from "../../config/env";
import type { DaemonSessions } from "./DaemonSessions";
import { BackgroundBindingRegistryUpgrade } from "../sessionBroker/registry/BackgroundBindingRegistryUpgrade";

export interface DaemonBrokerHost {
  readPersistedSession: DaemonDeviceSessionStore["getSession"];
  warmConfirmedManagedExecution: (sessionUuid: string) => Promise<void>;
  services: Pick<
    DaemonCoreServices,
    | "iosDeviceVerifier"
    | "deviceReadiness"
    | "sessionManager"
    | "devicePool"
    | "deviceSessionRepository"
    | "timer"
    | "passiveWorkPolicy"
    | "daemonState"
  >;
  identity: Pick<
    DaemonIdentityState,
    "socketBindCommitted" | "daemonSessionId" | "processGenerationToken"
  >;
  lifecycle: Pick<
    DaemonLifecycleState,
    | "sessionBrokerConfigPath"
    | "managedExecutionReowner"
    | "setManagedExecutionReowner"
    | "shutdownInProgress"
    | "backgroundRegistryUpgrade"
    | "setBackgroundRegistryUpgrade"
  >;
  bindingRegistry: () => Promise<SqliteBindingRegistry> | undefined;
  deviceClaimMirrors: () => DeviceClaimMirrorHub;
  setBindingRegistry: (value: Promise<SqliteBindingRegistry> | undefined) => void;
  brokerDeviceAcquisition: () => DaemonBrokerDeviceAcquisitionHandle | undefined;
  setBrokerDeviceAcquisition: (value: DaemonBrokerDeviceAcquisitionHandle | undefined) => void;
  openBindingRegistry: DaemonBroker["openBindingRegistry"];
  cancelAndReleaseSession: DaemonSessions["cancelAndReleaseSession"];
}

export function sessionBrokerAndroidResetPorts(
  readiness: () => Pick<
    ReturnType<DaemonBrokerHost["services"]["deviceReadiness"]>,
    | "listBootedAndroidDevices"
    | "verifyAndroidCtrlProxyServiceReady"
    | "readAndroidCtrlProxySnapshotIdentity"
    | "verifyDevice"
  >,
): NonNullable<OpenSessionBrokerServiceOptions["androidReset"]> {
  return {
    inventory: (options) =>
      readiness().listBootedAndroidDevices({
        signal: options.signal,
        androidTargetDeviceId: options.targetDeviceId,
        skipAndroidProfileEnrichment: true,
      }),
    ctrlProxyReady: (device, options) =>
      readiness().verifyAndroidCtrlProxyServiceReady(device, options),
    snapshot: {
      ctrlProxyIdentity: (device, signal) =>
        readiness().readAndroidCtrlProxySnapshotIdentity(device, signal),
      ready: async (device, step) => {
        await step.assertOwned();
        await readiness().verifyDevice(
          device.deviceId,
          "android",
          { signal: step.signal, readiness: "automationReady" },
          device,
        );
        await step.assertOwned();
      },
    },
  };
}

/** Owns broker bindings, execution ownership, registry upgrades and settlement lifetimes. */
export class DaemonBroker {
  private brokerExecutionRelease: BrokerExecutionRelease | undefined;

  private sessionBrokerService: SessionBrokerService | undefined;

  private sessionBrokerConfig: SessionBrokerHostConfig | undefined;

  private bindingExecOwnerLiveness: BindingExecOwnerLiveness | undefined;

  /** Journal entries this daemon is driving; shared by the drain and the binding reconciler. */
  private readonly bindingJournalInFlight = new BindingJournalInFlight();

  private bindingRedrive: BindingJournalRedriveLoop | undefined;
  private readonly maintainedRegistries = new WeakSet<SqliteBindingRegistry>();
  private registryClosing = false;
  constructor(private readonly host: DaemonBrokerHost) {}

  /**
   * Wire the broker execution drain and managed-session release listener (#11177). The host-wide
   * binding registry opens lazily, on the first managed execution's release, so daemons that never
   * serve a broker binding never touch it.
   */
  installManagedExecutionRelease(): void {
    const release = new BrokerExecutionRelease({
      registry: () => this.host.openBindingRegistry(),
      journal: { inFlight: this.bindingJournalInFlight },
      work: executionTracker,
      sessions: managedExecutionSessionsFrom(
        this.host.services.sessionManager(),
        lazySessionReleasePool(() => this.host.services.devicePool()),
      ),
      timer: this.host.services.timer(),
      settler: this.bindingJournalOwner(),
      isExecOwnerLive: this.bindingOwnerLiveness(),
      ownership: {
        isReleaseHeld: (id) =>
          this.host.lifecycle.managedExecutionReowner()?.isReleaseHeld(id) ?? false,
        confirmOwnership: (id) =>
          this.host.lifecycle.managedExecutionReowner()?.confirmOwnership(id),
        loseOwnership: (id) => this.host.lifecycle.managedExecutionReowner()?.loseOwnership(id),
      },
    });
    this.brokerExecutionRelease = release;
    this.host.services
      .sessionManager()
      .onSessionRelease((_sessionId, _deviceId, _reason, snapshot, options) =>
        release.onSessionReleased(snapshot, options),
      );
  }

  /**
   * Owner liveness as this daemon judges it, shared by the registry, the settlement watcher and the
   * scope reset so they never disagree. A live execution's binding is in use while this daemon holds
   * its session, even when the recorded owner is a previous daemon that died with a restart
   * (#11275); a record this daemon wrote is judged by its session alone (#11339).
   */
  private bindingOwnerLiveness(): BindingExecOwnerLiveness {
    this.bindingExecOwnerLiveness ??= withLiveExecutionSessions(
      defaultBindingExecOwnerLiveness,
      this.host.services.sessionManager(),
    );
    return this.bindingExecOwnerLiveness;
  }

  /**
   * Rehydrated managed executions are live again, held by this daemon, but their bindings still name
   * the previous daemon as owner: re-own them now, before any acquisition or sweep sees a dead
   * owner (#11275). The proxy's re-bind re-owns them too; this covers the window before it.
   */
  async reownRehydratedManagedExecutions(rehydrated: readonly string[]): Promise<void> {
    const executions = rehydrated.filter((sessionUuid) =>
      this.host.services.sessionManager().isLiveManagedExecutionSession(sessionUuid),
    );
    await this.host.lifecycle.managedExecutionReowner()?.reown(executions, { rehydrated: true });
  }

  /** A host that never served a broker binding has no registry; maintenance must not create one. */
  private bindingRegistryExists(): boolean {
    return this.host.bindingRegistry() !== undefined || bindingRegistryFileExists();
  }

  /**
   * This daemon as a broker binding settler and journal owner (#11179): PID plus process-generation
   * token, so entries it opens are redriven by a later daemon once this process is gone.
   */
  bindingJournalOwner(): BindingJournalOwner {
    return {
      daemonId: this.host.identity.daemonSessionId(),
      ...currentBindingOwnerProcess(() => this.host.identity.processGenerationToken()),
    };
  }

  /**
   * Build the broker provisioning engine over the drain's lazily opened registry. Sessions release through
   * the same session-and-device path the drain uses.
   */
  installBrokerDeviceAcquisition(): void {
    const sessions = managedExecutionSessionsFrom(
      this.host.services.sessionManager(),
      lazySessionReleasePool(() => this.host.services.devicePool()),
    );
    const acquisition = createDaemonBrokerDeviceAcquisition({
      registry: () => this.host.openBindingRegistry(),
      // Unconfigured Android reuse destroys a released emulator, so its exit snapshot is waste.
      // Warm reuse (snapshot or keep-booted) and an unread config keep the default (#15477).
      discardAndroidSnapshotOnExit: () => discardsAndroidSnapshotOnExit(this.sessionBrokerConfig),
      // The broker and native ledger enforce the same cap independently: reservations are not
      // added to native usage twice, and unaccounted native devices can still refuse creation.
      resourceBudgetPolicy: {
        limit: () => this.sessionBrokerConfig?.limits.totalDeviceCap ?? null,
      },
      sessions: {
        claimLivenessOwnership: (sessionId, ownerToken) =>
          this.host.services.sessionManager().claimLivenessOwnership(sessionId, ownerToken),
        adoptManagedExecutionLivenessPolicy: (sessionId, options) =>
          this.host.services
            .sessionManager()
            .adoptManagedExecutionLivenessPolicy(sessionId, options),
        releaseSession: async (sessionId) => {
          await sessions.releaseSession(sessionId);
        },
      },
      pool: this.host.services.devicePool(),
      executions: this.host.services.sessionManager(),
      owner: () => this.bindingJournalOwner(),
      timer: this.host.services.timer(),
      journal: {
        owner: this.bindingJournalOwner(),
        inFlight: this.bindingJournalInFlight,
      },
    });
    this.host.setBrokerDeviceAcquisition(acquisition);
    this.host.lifecycle.setManagedExecutionReowner(
      new ManagedExecutionReowner({
        registry: () => this.host.openBindingRegistry(),
        registryExists: () => this.bindingRegistryExists(),
        owner: () => this.bindingJournalOwner(),
        timer: this.host.services.timer(),
        isSessionHeld: (id) =>
          this.host.services.sessionManager().isLiveManagedExecutionSession(id),
        isSessionPresent: (id) =>
          this.host.services.sessionManager().hasSession(id) ||
          this.host.services.sessionManager().getReleasingSession(id) !== null,
        deviceOf: (id) =>
          this.host.services
            .sessionManager()
            .getHeldDeviceSessions()
            .find((session) => session.sessionId === id)?.deviceId ?? null,
        onOwnershipLost: (id) => {
          void this.host
            .cancelAndReleaseSession(id, "binding-ownership-lost", {
              cutCallsLearnRelease: true,
            })
            .catch((error: unknown) => {
              logger.warn(`[Daemon] Lost managed execution ${id} release failed`, error);
            });
        },
        onOwnershipConfirmed: (id) => {
          void this.warmConfirmedManagedExecution(id).catch((error: unknown) => {
            logger.warn(`[Daemon] Confirmed managed execution ${id} iOS warm-up failed`, error);
          });
        },
      }),
    );
    this.host.services
      .daemonState()
      .setBrokerExecutionReowner(this.host.lifecycle.managedExecutionReowner()!);
    this.host.services
      .sessionManager()
      .setReleaseDeviceHold((id) =>
        this.host.lifecycle.managedExecutionReowner()?.releaseDeviceHold(id),
      );
    // Broker startup awaits registry retirement; local startup upgrades after exposing its socket.
  }

  /** The caller has observed an existing registry; local daemons never create one here. */
  startBackgroundRegistryUpgrade(): boolean {
    if (this.registryClosing || this.host.lifecycle.shutdownInProgress()) {
      return false;
    }
    // Broker startup owns registry preparation, so mirrors need not ask for a local upgrade.
    if (this.host.lifecycle.sessionBrokerConfigPath()) {
      return true;
    }
    if (!this.host.identity.socketBindCommitted()) {
      return false;
    }
    if (!this.host.lifecycle.backgroundRegistryUpgrade()) {
      const upgrade = new BackgroundBindingRegistryUpgrade(
        (signal) => this.host.openBindingRegistry(signal),
        { timer: this.host.services.timer() },
      );
      this.host.lifecycle.setBackgroundRegistryUpgrade(upgrade);
      upgrade.start();
    }
    return true;
  }

  openBindingRegistry(
    signal?: AbortSignal,
    options?: { quiet?: boolean },
  ): Promise<SqliteBindingRegistry> {
    const cached = this.host.bindingRegistry();
    if (cached) {
      return options?.quiet
        ? cached
        : cached.then((registry) => {
            this.startBindingRegistryMaintenance(registry);
            return registry;
          });
    }
    const opening = openSqliteBindingRegistry({
      // Rehydration may open here before startup reaches the socket: only brokers may upgrade
      // in that window. Local daemons retry from the post-bind background upgrade instead.
      migrate:
        this.host.lifecycle.sessionBrokerConfigPath() !== undefined ||
        this.host.identity.socketBindCommitted(),
      timer: this.host.services.timer(),
      isExecOwnerLive: this.bindingOwnerLiveness(),
      legacyDeviceRetirement: new LegacySlotDeviceRetirement({
        signal,
        timer: this.host.services.timer(),
        // Persisted legacy owners must be checked by process even before session rehydration.
        isOwnerLive: defaultBindingExecOwnerLiveness,
        devices: new PlatformLegacySlotDeviceStopper(new MultiPlatformDeviceManager(), {
          processes: new ProcessTableReader(new DefaultHostCommandExecutor(), {
            timer: this.host.services.timer(),
            processTableSupported: process.platform !== "win32",
            procFs: process.platform === "linux" ? nodeProcFs : undefined,
          }),
          readStates: async (signal) => {
            const adb = defaultAdbClientFactory.create(null);
            const reader = adb.getDeviceStates;
            if (!reader) {
              throw new ActionableError(
                "Android device-state discovery is unavailable for legacy retirement",
              );
            }
            return reader.call(adb, {
              signal,
              throwOnMissingAdb: true,
            });
          },
        }),
      }),
    });
    this.host.setBindingRegistry(opening);
    opening.then(
      (registry) => {
        // Claims taken before the registry opened, and releases still owed, reach the table now.
        this.host.deviceClaimMirrors().registryOpened(registry.deviceClaims());
        if (!options?.quiet) {
          this.startBindingRegistryMaintenance(registry);
        }
      },
      // The open failure is logged (and the open forgotten) by the handler below.
      () => undefined,
    );
    opening.catch((error: unknown) => {
      // The release that asked reports this failure; forgetting the failed open lets the next
      // release retry instead of failing forever.
      logger.debug(`[Daemon] Binding registry open failed: ${errorMessage(error)}`);
      if (this.host.bindingRegistry() === opening) {
        this.host.setBindingRegistry(undefined);
      }
    });
    return opening;
  }

  private startBindingRegistryMaintenance(registry: SqliteBindingRegistry): void {
    if (this.maintainedRegistries.has(registry)) {
      return;
    }
    this.maintainedRegistries.add(registry);
    // Local startup's quiet open only exposes durable claims to discovery; normal open sites
    // retain responsibility for restart-time settlement (#11242) and journal maintenance.
    void this.brokerExecutionRelease?.recoverSettledBindings();
    const acquisition = this.host.brokerDeviceAcquisition();
    if (
      acquisition &&
      !this.host.lifecycle.sessionBrokerConfigPath() &&
      !this.bindingRedrive &&
      readEnvRaw(AMBIENT_ENV.NODE_ENV) !== "test"
    ) {
      this.bindingRedrive = acquisition.startJournalRedrive(registry);
    }
  }

  /** Stop the drain's settlement watchers and close the binding registry if this daemon opened it. */
  async closeManagedExecutionRelease(): Promise<void> {
    // Mirrors are disposed later: fence late probes before the first shutdown await.
    this.registryClosing = true;
    await this.host.lifecycle.backgroundRegistryUpgrade()?.close();
    this.host.lifecycle.setBackgroundRegistryUpgrade(undefined);
    await this.sessionBrokerService?.close();
    this.sessionBrokerService = undefined;
    this.host.services.daemonState().setSessionBrokerService(undefined);
    this.brokerExecutionRelease?.close();
    this.host.lifecycle.managedExecutionReowner()?.close();
    // Interrupt discovery and the inter-pass wait, then join within 100ms of this stage's 200ms.
    // Unfinished cleanup stays journaled even if an unabortable registry call outlives the join.
    try {
      await this.bindingRedrive?.stop();
    } catch (error) {
      logger.warn(`[Daemon] Stopping journal redrive failed: ${errorMessage(error)}`, error);
    }
    this.bindingRedrive = undefined;
    this.host.brokerDeviceAcquisition()?.acquisition.close();
    this.host.setBrokerDeviceAcquisition(undefined);
    const registry = this.host.bindingRegistry();
    this.host.setBindingRegistry(undefined);
    // A write already sent must settle before this daemon's rows are removed below.
    this.host.deviceClaimMirrors().dispose();
    await this.host.deviceClaimMirrors().idle();
    try {
      // The device allocation claims are released after this stage, when the table is gone: this
      // daemon's rows leave with its registry so a clean stop strands none (#11811 b).
      await this.host.deviceClaimMirrors().releaseOwnedClaims((await registry)?.deviceClaims());
    } catch (error) {
      logger.warn(
        `[Daemon] Withdrawing this daemon's device claims failed: ${errorMessage(error)}`,
        error,
      );
    }
    try {
      await (await registry)?.close();
    } catch (error) {
      logger.warn(`[Daemon] Closing the binding registry failed: ${errorMessage(error)}`, error);
    }
  }

  async installSessionBroker(): Promise<Pick<SessionBrokerService, "start"> | undefined> {
    if (!this.host.lifecycle.sessionBrokerConfigPath() || this.sessionBrokerService) {
      return this.sessionBrokerService;
    }
    const acquisition = this.host.brokerDeviceAcquisition();
    const release = this.brokerExecutionRelease;
    if (!acquisition || !release) {
      throw new ActionableError(
        "Session broker requires the provider's native ownership and cleanup machinery",
      );
    }
    const registry = await this.host.openBindingRegistry();
    const config = await readSessionBrokerHostConfig(
      this.host.lifecycle.sessionBrokerConfigPath()!,
    );
    // Install configuration before exposing the service; startup recovers durable receipts only.
    this.sessionBrokerConfig = config;
    this.sessionBrokerService = await openSessionBrokerService({
      deferStart: true,
      config,
      registry,
      acquisition: acquisition.acquisition,
      release,
      journal: acquisition.journalFor(registry),
      mutationSessions: this.host.services.sessionManager(),
      owner: this.bindingJournalOwner(),
      timer: this.host.services.timer(),
      sessionDisposition: (sessionUuid) =>
        sessionDisposition(sessionUuid, {
          isLive: (uuid) => this.host.services.sessionManager().peekSession(uuid) !== null,
          getSession: (uuid) => this.host.readPersistedSession(uuid),
          timer: this.host.services.timer(),
        }),
      liveSessionIds: () =>
        this.host.services
          .sessionManager()
          .getAllSessions()
          .map((session) =>
            this.host.services.sessionManager().ownershipSessionUuid(session.sessionId),
          ),
      androidReset: sessionBrokerAndroidResetPorts(() => this.host.services.deviceReadiness()),
    });
    this.host.services.daemonState().setSessionBrokerService(this.sessionBrokerService);
    // No generic journal work starts before the exclusive host lock and inventory checks.
    if (!this.bindingRedrive && readEnvRaw(AMBIENT_ENV.NODE_ENV) !== "test") {
      this.bindingRedrive = acquisition.startJournalRedrive(registry);
    }
    return this.sessionBrokerService;
  }

  private async warmConfirmedManagedExecution(sessionUuid: string): Promise<void> {
    return this.host.warmConfirmedManagedExecution(sessionUuid);
  }

  get testHooks() {
    return {
      startBackgroundRegistryUpgrade: (): boolean => this.startBackgroundRegistryUpgrade(),
      openBindingRegistry: (...args: Parameters<DaemonBroker["openBindingRegistry"]>) =>
        this.host.openBindingRegistry(...args),
      closeManagedExecutionRelease: (): Promise<void> => this.closeManagedExecutionRelease(),
      bindingJournalOwner: (): BindingJournalOwner => this.bindingJournalOwner(),
      setBindingRegistry: (registry: Promise<SqliteBindingRegistry>): void => {
        this.host.setBindingRegistry(registry);
      },
    } as const;
  }
}
