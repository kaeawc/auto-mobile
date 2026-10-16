import { ActionableError, toActionableError } from "../../models/ActionableError";
import {
  readAndroidSessionDeviceCatalog,
  readIosSessionDeviceCatalog,
} from "../../devices/sessionCatalog";
import type { SessionDeviceCatalog } from "../../devices/sessionRequirements";
import {
  listDevices,
  listInstalledSystemImages,
} from "../../utils/android-cmdline-tools/avdmanager";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { tryAcquireExclusiveLock, releaseExclusiveLock } from "../../utils/fileLock";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import type { Timer } from "../../utils/SystemTimer";
import { defaultLockOwnerGenerationProbe } from "../lockOwnerGeneration";
import type { BrokerDeviceAcquisition } from "./provisioning/deviceAcquisition";
import { defaultBindingToolInvoker } from "./provisioning/daemonDeviceAcquisition";
import { readToolPayload } from "./provisioning/reconcilerPorts";
import type { BrokerExecutionRelease } from "./provisioning/executionRelease";
import type { BindingJournal } from "./registry/bindingJournal";
import {
  defaultBindingRegistryPath,
  type SqliteBindingRegistry,
} from "./registry/sqliteBindingRegistry";
import { computeBindingScopeKey, type BindingProcessIdentity } from "./registry/bindingRegistry";
import { SessionBroker, type SessionBrokerOptions } from "./broker";
import { ManagedDevicePort } from "./managedDevicePort";
import { SESSION_BROKER_SCOPE, type SessionBrokerHostConfig } from "./hostConfig";
import { IosBaselineReset } from "./iosBaselineReset";
import type { SqliteSessionBrokerStore } from "./sqliteStore";
import type { BrokerResourceRecord } from "./store";

export interface SessionBrokerHostLock {
  acquire(): void;
  release(): void;
}

/** Existing PID/generation lock primitive, held for the lifetime of the broker service. */
export function sessionBrokerHostLock(
  owner: BindingProcessIdentity,
  path = `${defaultBindingRegistryPath()}.session-broker.lock`,
): SessionBrokerHostLock {
  return {
    acquire: () => {
      if (
        !tryAcquireExclusiveLock(path, {
          pid: owner.pid,
          ownerToken: owner.daemonId,
          ownerGeneration: defaultLockOwnerGenerationProbe,
        })
      ) {
        throw new ActionableError(
          "Another provider owns session-broker execution on this host; stop it before starting a replacement",
        );
      }
    },
    release: () => releaseExclusiveLock(path, owner.pid, owner.daemonId),
  };
}

export interface OpenSessionBrokerServiceOptions {
  config: SessionBrokerHostConfig;
  registry: SqliteBindingRegistry;
  acquisition: Pick<BrokerDeviceAcquisition, "acquire">;
  release: Pick<BrokerExecutionRelease, "releaseExecution">;
  journal: Pick<BindingJournal, "owner" | "redriveBinding">;
  owner: BindingProcessIdentity;
  timer: Timer;
  sessionDisposition: NonNullable<SessionBrokerOptions["sessionDisposition"]>;
  /** Already rehydrated base sessions; generic work must be drained before opting in. */
  liveSessionIds?: () => readonly string[];
  /** Tests supply a fake host lock; production shares the registry's physical namespace. */
  hostLock?: SessionBrokerHostLock;
  catalog?: (platform: "ios" | "android", signal?: AbortSignal) => Promise<SessionDeviceCatalog>;
}

function nativeCatalogReader(config: SessionBrokerHostConfig) {
  const ios = new SimCtlClient(null);
  return (platform: "ios" | "android", signal?: AbortSignal): Promise<SessionDeviceCatalog> => {
    if (platform === "ios") {
      return readIosSessionDeviceCatalog(ios, {
        signal,
        classifications: config.iosClassifications,
      });
    }
    return readAndroidSessionDeviceCatalog(
      {
        listDevices: (signal) => listDevices(undefined, signal),
        listInstalledSystemImages: (filter, signal) =>
          listInstalledSystemImages(filter, undefined, signal),
      },
      { profileArchetypes: config.androidProfileArchetypes },
      { signal },
    );
  };
}

/**
 * Opens one exclusive host service using the existing native assignment/journal authority.
 * Legacy binding/free-pool inventory must be drained before opting in; it cannot disappear from cap
 * accounting merely because it was created by another allocation path.
 */
export async function openSessionBrokerService(
  options: OpenSessionBrokerServiceOptions,
): Promise<SessionBrokerService> {
  const lock = options.hostLock ?? sessionBrokerHostLock(options.owner);
  lock.acquire();
  try {
    const scopeKey = computeBindingScopeKey(SESSION_BROKER_SCOPE);
    await assertBrokerInventoryOwned(options.registry, scopeKey);
    await assertBrokerSessionsOwned(options, scopeKey);
    const scope = await options.registry.ensureScope(SESSION_BROKER_SCOPE);
    if (scope.kind !== "ready") {
      throw new ActionableError(
        `Session broker's private ownership scope is unavailable: ${scope.kind}`,
      );
    }
    const store = options.registry.sessionBrokerStore(scopeKey);
    const reset = options.config.reuseCleanDevices ? nativeIosBaselineReset() : undefined;
    const devices = new ManagedDevicePort({
      scope: SESSION_BROKER_SCOPE,
      brokerDeviceAcquisition: options.acquisition,
      brokerExecutionRelease: options.release,
      registry: options.registry,
      bindingJournal: options.journal,
      ...(reset
        ? {
            resetIosBaseline: reset.reset.bind(reset),
            isCurrentReset: (resource: BrokerResourceRecord) => isCurrentReset(store, resource),
          }
        : {}),
    });
    const broker = new SessionBroker({
      store,
      devices,
      owner: options.owner,
      limits: options.config.limits,
      catalog: options.catalog ?? nativeCatalogReader(options.config),
      defaults: (platform) => {
        const defaults = options.config.defaults[platform];
        if (!defaults) {
          throw new ActionableError(
            `Session-broker execution is not configured for ${platform} on this host`,
          );
        }
        return defaults;
      },
      sessionDisposition: options.sessionDisposition,
      reuseCleanDevices: options.config.reuseCleanDevices,
    });
    await broker.recover();
    const service = new SessionBrokerService(broker, scopeKey, lock, options.timer);
    service.start();
    return service;
  } catch (error) {
    lock.release();
    throw toActionableError(error, "Session broker startup failed");
  }
}

function nativeIosBaselineReset(): IosBaselineReset {
  return new IosBaselineReset({
    simctl: new SimCtlClient(null),
    stopDevice: async (device) => {
      // The ordinary lifecycle handler joins device controllers and invalidates caches before
      // erasure. A raw simctl shutdown would skip that provider bookkeeping.
      const result = readToolPayload(
        await defaultBindingToolInvoker("killDevice", { device }, undefined),
      );
      if (result.isError || result.payload.success === false) {
        throw new ActionableError(
          "Provider device shutdown did not confirm a clean controller teardown",
        );
      }
    },
  });
}

async function isCurrentReset(
  store: SqliteSessionBrokerStore,
  expected: BrokerResourceRecord,
): Promise<boolean> {
  const current = (await store.listResources()).find(
    (resource) => resource.resourceId === expected.resourceId,
  );
  return (
    current?.state === "resetting" &&
    current.revision === expected.revision &&
    current.requestId === expected.requestId &&
    current.scopeKey === expected.scopeKey
  );
}

async function assertBrokerSessionsOwned(
  options: OpenSessionBrokerServiceOptions,
  scopeKey: string,
): Promise<void> {
  const live = options.liveSessionIds?.() ?? [];
  if (live.length === 0) {
    return;
  }
  const requests = await options.registry.sessionBrokerStore(scopeKey).listRequests();
  const known = new Set(
    requests.flatMap((request) => (request.sessionId ? [request.sessionId] : [])),
  );
  // A create can have claimed native ownership before the broker's active receipt committed.
  for (const device of await options.registry.snapshotManagedDevices()) {
    if (device.scopeKey === scopeKey && device.execSessionUuid) {
      known.add(device.execSessionUuid);
    }
  }
  if (live.some((session) => !known.has(session))) {
    throw new ActionableError(
      "Session-broker mode requires prior generic sessions to be drained before startup",
    );
  }
}

async function assertBrokerInventoryOwned(
  registry: SqliteBindingRegistry,
  scopeKey: string,
): Promise<void> {
  const resources = await registry.sessionBrokerStore(scopeKey).listResources();
  const occupied = new Set(
    resources
      .filter((resource) => resource.state !== "destroyed")
      .map((resource) => resource.allocationIndex),
  );
  const foreign = (await registry.snapshotManagedDevices()).some(
    (device) =>
      device.scopeKey !== scopeKey ||
      device.holder !== "session_broker" ||
      device.bindingIndex === null ||
      !occupied.has(device.bindingIndex),
  );
  const foreignJournal = (await registry.listOpenBindingJournal()).some(
    (entry) => entry.scopeKey !== scopeKey || !occupied.has(entry.bindingIndex),
  );
  if (foreign || foreignJournal) {
    throw new ActionableError(
      "Session-broker mode requires prior or unaccounted managed allocations to be drained; existing inventory remains untouched",
    );
  }
}

/** Explicit owner of the recovery loop, including interruptible idle waiting and a joined stop. */
/** Receipt retention runs at most this often; pruning is not urgent and takes the write lock. */
export const RECEIPT_PRUNE_INTERVAL_MS = 60 * 60 * 1000;

export class SessionBrokerService {
  private stopped = false;
  private lastPruneAtMs: number | undefined;
  private running: Promise<void> | undefined;
  private closing: Promise<void> | undefined;
  private wake: (() => void) | undefined;

  constructor(
    readonly broker: SessionBroker,
    readonly scopeKey: string,
    private readonly lock: SessionBrokerHostLock,
    private readonly timer: Pick<Timer, "setTimeout" | "clearTimeout" | "now">,
  ) {}

  start(): void {
    this.running ??= this.loop();
  }

  close(): Promise<void> {
    this.closing ??= this.stop();
    return this.closing;
  }

  private async stop(): Promise<void> {
    this.stopped = true;
    this.wake?.();
    await this.running;
    await this.broker.close();
    // Keep ownership if broker shutdown throws: the process's eventual exit makes the lock
    // reclaimable, whereas releasing it early could admit a successor over unfinished work.
    this.lock.release();
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      await this.wait();
      if (this.stopped) {
        return;
      }
      try {
        await this.broker.recover();
      } catch (error) {
        logger.warn(`Session broker recovery remains pending: ${errorMessage(error)}`);
      }
      await this.pruneIfDue();
    }
  }

  private async pruneIfDue(): Promise<void> {
    const now = this.timer.now();
    if (this.lastPruneAtMs !== undefined && now - this.lastPruneAtMs < RECEIPT_PRUNE_INTERVAL_MS) {
      return;
    }
    this.lastPruneAtMs = now;
    try {
      await this.broker.pruneReceipts();
    } catch (error) {
      // Retention is housekeeping; a busy registry only delays it to the next interval.
      logger.warn(`Session broker receipt retention failed: ${errorMessage(error)}`, error);
    }
  }

  private wait(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => {
        this.wake = undefined;
        resolve();
      };
      const timeout = this.timer.setTimeout(done, 5_000);
      this.wake = () => {
        this.timer.clearTimeout(timeout);
        done();
      };
    });
  }
}
