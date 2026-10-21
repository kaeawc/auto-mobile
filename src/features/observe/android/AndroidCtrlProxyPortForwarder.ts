/** Cross-process ownership, setup and reconciliation of Android CtrlProxy forwards. */
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Timer } from "../../../utils/SystemTimer";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import { PerformanceTracker, NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { exponentialBackoff, fixedBackoff } from "../../../utils/Backoff";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../../utils/toolUtils";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../../utils/PortManager";
import { CtrlProxyForwardingLeaseConflictError } from "../shared/CtrlProxyForwardingLeaseConflictError";
import type { CtrlProxyForwardLease, ForwardLeaseReclaimResult } from "./CtrlProxyForwardLease";
import type { ForwardClientConnectionProbe } from "./CtrlProxyForwardClientProbe";
import { isCtrlProxyHostPortFree } from "./ctrlProxyHostPortProbe";
import {
  describeForeignCtrlProxyForwards,
  listedCtrlProxyForwardPorts,
  parseOwnPortForward,
  localPortFromForward,
  rememberForeignForwardClients,
  liveRememberedForwardClients,
  pruneForeignForwardMemory,
} from "./foreignCtrlProxyForwardEvidence";

// Three attempts preserve the existing connection retry bound.
export const CTRL_PROXY_CONNECT_ATTEMPTS = 3;

/** adb's bind failure for `forward`: "cannot bind listener: Address already in use". */
const ADB_FORWARD_ADDRESS_IN_USE_PATTERN = /address already in use|EADDRINUSE/i;

/** Client-backed accessor properties resolve live state on every use, including after awaits. */
export interface AndroidCtrlProxyPortForwarderContext {
  readonly adb: Pick<AdbExecutor, "execute">;
  readonly timer: Pick<Timer, "now" | "sleep">;
  readonly deviceId: string;
  readonly ctrlProxyForwardLease: CtrlProxyForwardLease;
  readonly forwardClientProbe: ForwardClientConnectionProbe;
  readonly forwardClientProcessIsRunning: (pid: number) => boolean;
  readonly closed: boolean;
  localPort: number;
  readonly portAllocationId: string;
  portForwardingSetup: boolean;
  set forwardSetupFailure(failure: string | undefined);
  readonly forwardLeaseForceReleased: boolean;
  getLiveLocalPorts(): ReadonlySet<number>;
}

/**
 * Actionable message for a CtrlProxy forwarding-lease conflict (issue #6260).
 * Named the owning PID when known, so a client is pointed at the orphan
 * process rather than left to guess or, worse, blame the device. When the
 * owner was asked and refused the takeover (issue #10497), the message names
 * its socket and the reason, such as its live session.
 */
function describeCtrlProxyForwardingLeaseConflict(
  deviceId: string,
  ownerPid: number | undefined,
  refusal?: ForwardLeaseReclaimResult,
): string {
  if (ownerPid !== undefined && refusal?.ownerSocketPath !== undefined) {
    return (
      `Another AutoMobile process (PID ${ownerPid}, socket ${refusal.ownerSocketPath}) owns ` +
      `CtrlProxy forwarding for ${deviceId} and kept it because ${refusal.reason}. Release that ` +
      `session or stop that process (\`kill ${ownerPid}\`), then retry.`
    );
  }
  if (ownerPid !== undefined) {
    return (
      `Another AutoMobile process (PID ${ownerPid}) owns CtrlProxy forwarding for ${deviceId}. ` +
      `This is usually a stale/orphaned AutoMobile daemon left behind by an incomplete ` +
      `\`--daemon restart\` — stop it (\`kill ${ownerPid}\`) and retry.`
    );
  }
  return (
    `Another AutoMobile process owns CtrlProxy forwarding for ${deviceId}. This is usually a ` +
    `stale/orphaned AutoMobile daemon — run \`--daemon restart\` or find and stop it directly.`
  );
}

/** What the host TCP table says about who uses a set of CtrlProxy forwards. */
export type ForwardClientEvidence =
  | { clientPidsByPort: Map<number, number[]> }
  | { probeFailure: string };

/**
 * Raise the appropriate error for a failed {@link CtrlProxyForwardLease.tryAcquire}
 * (issue #6260 / PRRT_kwDOP-GF5M6fuKn9). Split out of `setupPortForwarding` to keep
 * that method's branching complexity down; always throws.
 */
function throwCtrlProxyForwardingLeaseConflict(
  deviceId: string,
  ownerPid: number | undefined,
  refusal?: ForwardLeaseReclaimResult,
): never {
  if (ownerPid === process.pid) {
    // Same-process transient, NOT an orphan: shutdown recovery can evict a
    // singleton while its in-flight setup still holds the lease, so a
    // REPLACEMENT client constructed in THIS SAME process can observe its own
    // PID as the current owner. Naming and suggesting `kill` on that PID would
    // tell the caller to kill itself. This case must keep waiting for the live
    // in-process lease to release rather than reclaim it (see
    // `FileCtrlProxyForwardLease.tryAcquire` — reclaiming mid-setup would let
    // two instances race the same port forward), so throw the same plain,
    // non-actionable-kill error this path threw before this diagnostic existed
    // and let the caller's existing retry path recover once the lease frees.
    throw new Error(describeCtrlProxyForwardingLeaseConflict(deviceId, undefined));
  }
  // Named explicitly (issue #6260): this typed error is detected by
  // RunnerReadinessService to replace a generic, device-blaming
  // "runner did not become responsive" failure with the real, actionable
  // cause, and to fail fast rather than retry to the deadline (#10485).
  throw new CtrlProxyForwardingLeaseConflictError(
    describeCtrlProxyForwardingLeaseConflict(deviceId, ownerPid, refusal),
    ownerPid,
    refusal?.ownerSocketPath,
    refusal?.transient === true,
  );
}

export class AndroidCtrlProxyPortForwarder {
  static readonly FORWARD_CLIENT_PROBES = 2;
  static readonly FORWARD_PORT_ATTEMPTS = 4;
  static readonly FORWARD_CLIENT_REPROBE_INTERVAL_MS = 1_000;

  constructor(private readonly context: AndroidCtrlProxyPortForwarderContext) {}

  async ensureLocalPortAvailableForForwarding(signal?: AbortSignal): Promise<void> {
    if (this.context.closed) {
      return;
    }
    const currentAllocation = PortManager.getPort(this.context.portAllocationId);
    let currentPortIsAvailable = PortManager.isPortAvailable(this.context.localPort);
    if (currentAllocation === this.context.localPort) {
      const backoff = fixedBackoff(50);
      for (let attempt = 1; attempt <= CTRL_PROXY_CONNECT_ATTEMPTS; attempt++) {
        if (currentPortIsAvailable) {
          return;
        }
        if (this.context.closed) {
          return;
        }
        throwIfAborted(signal);
        // adb tears down its listener asynchronously after --remove; this short busy window is expected and bounded.
        logger.debug(
          `[CTRL_PROXY] Local port ${this.context.localPort} busy after forward removal; retrying probe (${attempt}/${CTRL_PROXY_CONNECT_ATTEMPTS})`,
        );
        await awaitWhileRequestIsLive(
          this.context.timer.sleep(backoff.delayForAttempt(attempt)),
          signal,
        );
        if (this.context.closed) {
          return;
        }
        throwIfAborted(signal);
        currentPortIsAvailable = PortManager.isPortAvailable(this.context.localPort);
      }
    }
    if (currentAllocation === this.context.localPort && currentPortIsAvailable) {
      return;
    }

    const additionalReservedPorts = currentPortIsAvailable ? [] : [this.context.localPort];
    PortManager.release(this.context.portAllocationId);
    const nextPort = PortManager.allocate(this.context.portAllocationId, {
      reservedPorts: [...IOS_CTRL_PROXY_RESERVED_PORTS, ...additionalReservedPorts],
    });
    if (nextPort !== this.context.localPort) {
      logger.info(
        `[CTRL_PROXY] Reallocated local port from ${this.context.localPort} to ${nextPort} before adb forward`,
      );
      this.context.localPort = nextPort;
    }
  }

  /**
   * Run `adb forward` on a host port that was bind-probed just now, moving to the
   * next free port when the probe fails or adb still reports the port in use
   * (another forward or process claimed it after allocation, #10795).
   */
  async forwardOnFreeLocalPort(signal?: AbortSignal): Promise<void> {
    for (let attempt = 1; ; attempt++) {
      const isLastAttempt = attempt >= AndroidCtrlProxyPortForwarder.FORWARD_PORT_ATTEMPTS;
      if (!isLastAttempt && !(await isCtrlProxyHostPortFree(this.context.localPort))) {
        logger.info(
          `[CTRL_PROXY] Local port ${this.context.localPort} is busy; selecting another port`,
        );
        await this.moveToNextFreeLocalPort(signal);
        continue;
      }
      try {
        await this.context.adb.execute(
          ["forward", `tcp:${this.context.localPort}`, `tcp:${PortManager.DEVICE_PORT}`],
          { signal },
        );
        return;
      } catch (error) {
        if (isLastAttempt || !ADB_FORWARD_ADDRESS_IN_USE_PATTERN.test(errorMessage(error))) {
          throw error;
        }
        logger.warn(
          `[CTRL_PROXY] adb forward on tcp:${this.context.localPort} reported the port in use; retrying on the next port`,
        );
        await this.moveToNextFreeLocalPort(signal);
      }
    }
  }

  async moveToNextFreeLocalPort(signal?: AbortSignal): Promise<void> {
    const busyPort = this.context.localPort;
    PortManager.release(this.context.portAllocationId);
    this.context.localPort = PortManager.allocate(this.context.portAllocationId, {
      reservedPorts: [...IOS_CTRL_PROXY_RESERVED_PORTS, busyPort],
    });
    if (!(await this.removeCtrlProxyPortForward(this.context.localPort, signal))) {
      throw new Error(
        `Failed to remove existing CtrlProxy forward on tcp:${this.context.localPort}`,
      );
    }
  }

  /**
   * Acquire this device's cross-process forwarding lease, taking it over from a
   * live owner that reports it no longer uses the device (issue #10497).
   */
  async acquireCtrlProxyForwardLease(): Promise<void> {
    const lease = this.context.ctrlProxyForwardLease;
    if (lease.tryAcquire()) {
      return;
    }
    const ownerPid = lease.getLastOwnerPid();
    const reclaim =
      ownerPid !== undefined && ownerPid !== process.pid
        ? await lease.tryReclaimFromStaleOwner?.()
        : undefined;
    if (reclaim?.acquired) {
      return;
    }
    throwCtrlProxyForwardingLeaseConflict(
      this.context.deviceId,
      reclaim?.ownerPid ?? ownerPid,
      reclaim,
    );
  }

  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  async setupPortForwarding(
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
    signal?: AbortSignal,
  ): Promise<void> {
    if (this.context.closed) {
      return;
    }
    this.context.forwardSetupFailure = undefined;
    await this.acquireCtrlProxyForwardLease();
    // Verify port forwarding is still active even if we think it's set up
    // Port forwarding can be lost if ADB server restarts or emulator restarts
    if (this.context.portForwardingSetup) {
      const isActive = await this.isPortForwardingActive(signal);
      if (isActive) {
        logger.debug(
          `[CTRL_PROXY] Port forwarding already active (localhost:${this.context.localPort})`,
        );
        return;
      }
      logger.debug(`[CTRL_PROXY] Port forwarding was lost, re-establishing...`);
      this.context.portForwardingSetup = false;
    }

    try {
      await this.sweepOrphanedCtrlProxyPortForwards(signal);

      const previousLocalPort = this.context.localPort;
      const clearedCurrentPort = await perf.track(
        "clearPortForward",
        async () => await this.removeCtrlProxyPortForward(this.context.localPort, signal),
      );
      if (!clearedCurrentPort) {
        throw new Error(
          `Failed to remove existing CtrlProxy forward on tcp:${this.context.localPort}`,
        );
      }
      await this.ensureLocalPortAvailableForForwarding(signal);
      if (this.context.closed) {
        return;
      }
      logger.debug(
        `[CTRL_PROXY] Setting up port forwarding for WebSocket: localhost:${this.context.localPort} → device:${PortManager.DEVICE_PORT} (device: ${this.context.deviceId})`,
      );

      if (this.context.localPort !== previousLocalPort) {
        const clearedReallocatedPort = await perf.track(
          "clearReallocatedPortForward",
          async () => await this.removeCtrlProxyPortForward(this.context.localPort, signal),
        );
        if (!clearedReallocatedPort) {
          throw new Error(
            `Failed to remove existing CtrlProxy forward on tcp:${this.context.localPort}`,
          );
        }
      }

      await perf.track("setupPortForward", () => this.forwardOnFreeLocalPort(signal));
      this.context.ctrlProxyForwardLease.recordOwnedForward?.(this.context.localPort);

      if (this.context.closed) {
        await this.removeCtrlProxyPortForward(this.context.localPort);
        return;
      }

      this.context.portForwardingSetup = true;
      logger.debug(
        `[CTRL_PROXY] Port forwarding setup complete (localhost:${this.context.localPort})`,
      );
    } catch (error) {
      this.context.forwardSetupFailure = `Failed to establish adb forward for ${this.context.deviceId}: ${errorMessage(error)}`;
      logger.warn(`[CTRL_PROXY] Failed to setup port forwarding: ${error}`);
      throw error;
    }
  }

  /**
   * Remove stale local forwards for this device that target CtrlProxy's fixed
   * device port. A daemon crash drops the in-memory singleton registry but
   * leaves ADB's forwards alive; the next client setup is their recovery path.
   *
   * A newly-created singleton is registered before it can start connecting, so
   * its allocated port is treated as live even before port forwarding completes.
   */
  /** @internal Test seam for CtrlProxyClient tests (#7992); not part of the public API. */
  async sweepOrphanedCtrlProxyPortForwards(signal?: AbortSignal): Promise<void> {
    let stdout: string;
    const listedAt = this.context.timer.now();
    try {
      const result = await this.context.adb.execute(["forward", "--list"], { signal });
      stdout = result.stdout;
    } catch (error) {
      logger.warn(
        `[CTRL_PROXY] Failed to list forwards while reconciling device ${this.context.deviceId}: ${error}`,
        error,
      );
      throw error;
    }

    const listedPorts = this.listedCtrlProxyForwardPorts(stdout);
    this.pruneStaleCtrlProxyForwardRecords(listedPorts, listedAt);
    const livePorts = this.context.getLiveLocalPorts();
    const listed = [...listedPorts];
    // No record in this coordination directory: possibly another daemon's (#10690).
    const unrecordedPorts = listed.filter((port) => !this.ownsCtrlProxyPortForward(port));
    const orphanedPorts = listed.filter(
      (port) => this.ownsCtrlProxyPortForward(port) && !livePorts.has(port),
    );

    pruneForeignForwardMemory(this.context.deviceId, new Set(unrecordedPorts));
    if (unrecordedPorts.length > 0) {
      await this.resolveUnrecordedCtrlProxyForwards(unrecordedPorts, signal);
    }
    await this.reclaimRecordedOrphanForwards(orphanedPorts, signal);
  }

  /** Host ports of this device's forwards to the CtrlProxy device port. */
  listedCtrlProxyForwardPorts(stdout: string): Set<number> {
    return listedCtrlProxyForwardPorts(this.context.deviceId, stdout);
  }

  /**
   * Remove forwards recorded in this coordination directory that no live
   * client of this process uses: a crashed daemon's leftovers. A record alone
   * is not proof (#10690): after an ADB restart the same serial and host port
   * can be forwarded again by a daemon this process cannot see, and the record
   * outlives the forward it described. A forward another process is connected
   * to is therefore left alone and its stale record dropped. When the host
   * connections cannot be read, the pruned record is the best evidence left.
   * Re-probes like the unrecorded path and reports a retryable conflict (#11106).
   */
  async reclaimRecordedOrphanForwards(ports: number[], signal?: AbortSignal): Promise<void> {
    if (ports.length === 0) {
      return;
    }
    const evidence = await this.findForeignForwardClients(
      ports,
      AndroidCtrlProxyPortForwarder.FORWARD_CLIENT_PROBES,
      signal,
    );
    const clients = "clientPidsByPort" in evidence ? evidence.clientPidsByPort : new Map();
    const contested = ports.filter((port) => clients.has(port));
    for (const port of contested) {
      logger.warn(
        `[CTRL_PROXY] Dropping CtrlProxy forward record for ${this.context.deviceId} tcp:${port}: ` +
          `PID ${clients.get(port)?.join(", ")} is connected to it`,
      );
      this.context.ctrlProxyForwardLease.forgetOwnedForward?.(port);
    }
    for (const port of ports.filter((candidate) => !clients.has(candidate))) {
      logger.info(
        `[CTRL_PROXY] Reclaiming orphaned CtrlProxy forward on ${this.context.deviceId} tcp:${port}`,
      );
      if (!(await this.removeCtrlProxyPortForward(port, signal))) {
        throw new Error(
          `Failed to reclaim orphaned CtrlProxy forward on ${this.context.deviceId} tcp:${port}`,
        );
      }
    }
    if (contested.length > 0) {
      // Transient (#11106): the record proves this coordination domain made the
      // forward, so a client still connected after the bounded re-probes is
      // usually a stray dialing the fixed host port. The record is dropped
      // above, so the retry re-judges the port as unrecorded and fails closed
      // (non-transient) if a live daemon really owns it.
      this.throwForeignCtrlProxyForwards(contested, { clientPidsByPort: clients }, true);
    }
  }

  /**
   * Decide whether unrecorded CtrlProxy forwards are still in use (#10690). A
   * daemon of any release, in any coordination directory, keeps a WebSocket
   * open to its forward's host port, so a client connection from another
   * process means the forward is live and must be left alone. Two probes a
   * moment apart cover a client caught between reconnects. With no client on
   * either probe and no remembered foreign PID still alive, the forward is
   * a leftover (a stopped older daemon, or a crash) and is removed. Remembered
   * live PIDs keep it foreign across socket disconnects (#12220).
   * A failed probe cannot rule a client out, so it
   * refuses rather than risk removing a live forward.
   */
  async resolveUnrecordedCtrlProxyForwards(ports: number[], signal?: AbortSignal): Promise<void> {
    const evidence = await this.findForeignForwardClients(
      ports,
      AndroidCtrlProxyPortForwarder.FORWARD_CLIENT_PROBES,
      signal,
      true,
    );
    const rememberedOnly = "clientPidsByPort" in evidence && evidence.clientPidsByPort.size === 0;
    if ("clientPidsByPort" in evidence) {
      for (const port of ports) {
        const remembered = liveRememberedForwardClients(
          this.context.deviceId,
          port,
          this.context.forwardClientProcessIsRunning,
        );
        if (remembered.length > 0) {
          evidence.clientPidsByPort.set(port, [
            ...new Set([...(evidence.clientPidsByPort.get(port) ?? []), ...remembered]),
          ]);
        }
      }
    }
    if ("probeFailure" in evidence || evidence.clientPidsByPort.size > 0) {
      this.throwForeignCtrlProxyForwards(ports, evidence, false, rememberedOnly);
    }
    for (const port of ports) {
      logger.warn(
        `[CTRL_PROXY] Reclaiming legacy/unrecorded CtrlProxy forward on ${this.context.deviceId} ` +
          `tcp:${port}: no other process is connected to it`,
      );
      // Removed without writing a record first, so a failed removal cannot
      // leave a record claiming another daemon's forward (#10690).
      if (!(await this.removeCtrlProxyPortForward(port, signal, { reclaimUnrecorded: true }))) {
        throw new Error(
          `Failed to reclaim unrecorded CtrlProxy forward on ${this.context.deviceId} tcp:${port}`,
        );
      }
    }
  }

  throwForeignCtrlProxyForwards(
    ports: number[],
    evidence: ForwardClientEvidence,
    transient = false,
    rememberedOnly = false,
  ): never {
    const clientPids =
      "clientPidsByPort" in evidence
        ? [...new Set([...evidence.clientPidsByPort.values()].flat())]
        : [];
    throw new CtrlProxyForwardingLeaseConflictError(
      describeForeignCtrlProxyForwards(
        this.context.deviceId,
        ports,
        this.context.ctrlProxyForwardLease.ownershipDirectory?.(),
        "probeFailure" in evidence ? evidence : { clientPids, rememberedOnly },
      ),
      clientPids[0],
      undefined,
      transient,
    );
  }

  /**
   * Other processes' client connections to each of `ports`, unioned over
   * `probes` reads spaced {@link FORWARD_CLIENT_REPROBE_INTERVAL_MS} apart.
   */
  async findForeignForwardClients(
    ports: number[],
    probes: number,
    signal?: AbortSignal,
    rememberUnrecorded = false,
  ): Promise<ForwardClientEvidence> {
    const clientPidsByPort = new Map<number, number[]>();
    const remember = rememberUnrecorded ? rememberForeignForwardClients : undefined;
    try {
      for (let probe = 0; probe < probes; probe++) {
        if (probe > 0) {
          await this.context.timer.sleep(
            AndroidCtrlProxyPortForwarder.FORWARD_CLIENT_REPROBE_INTERVAL_MS,
          );
        }
        for (const [port, pids] of await this.probeForwardClientsOnce(ports, signal)) {
          remember?.(this.context.deviceId, port, pids);
          clientPidsByPort.set(port, [
            ...new Set([...(clientPidsByPort.get(port) ?? []), ...pids]),
          ]);
        }
      }
    } catch (error) {
      signal?.throwIfAborted();
      logger.warn(
        `[CTRL_PROXY] Could not read host connections to CtrlProxy forwards on ` +
          `${this.context.deviceId}: ${errorMessage(error)}`,
        error,
      );
      return { probeFailure: errorMessage(error) };
    }
    return { clientPidsByPort };
  }

  /** Other processes' client connections to each of `ports` with any, read once. */
  async probeForwardClientsOnce(
    ports: number[],
    signal?: AbortSignal,
  ): Promise<Array<[number, number[]]>> {
    const perPort = await Promise.all(
      ports.map(async (port): Promise<[number, number[]]> => {
        const pids = await this.context.forwardClientProbe.findClientPids(port, signal);
        return [port, pids.filter((pid) => pid !== process.pid)];
      }),
    );
    return perPort.filter(([, pids]) => pids.length > 0);
  }

  /**
   * Drop this device's forward records whose forward is no longer listed (#10690).
   * Only records written before the listing started are judged: a forward
   * recorded later may have been created after the listing was taken.
   */
  pruneStaleCtrlProxyForwardRecords(listedPorts: Set<number>, listedAt: number): void {
    for (const record of this.context.ctrlProxyForwardLease.recordedForwards?.() ?? []) {
      if (listedPorts.has(record.localPort) || record.createdAt >= listedAt) {
        continue;
      }
      logger.info(
        `[CTRL_PROXY] Dropping stale CtrlProxy forward record for ${this.context.deviceId} ` +
          `tcp:${record.localPort}: ADB no longer lists the forward`,
      );
      this.context.ctrlProxyForwardLease.forgetOwnedForward?.(record.localPort);
    }
  }

  /**
   * Whether this process's coordination domain created the forward on `port`.
   * A lease without ownership records (the test-only no-op lease) predates
   * #10690 and treats every forward as its own.
   */
  ownsCtrlProxyPortForward(port: number): boolean {
    return this.context.ctrlProxyForwardLease.ownsForward?.(port) ?? true;
  }

  /**
   * Remove a forward only when it still maps this device and host port to the
   * CtrlProxy device port. Re-listing closes the race with a different service
   * reusing the host port after the orphan sweep discovered it.
   *
   * @returns `true` when no matching forward remains; `false` when adb failed
   * to establish that state.
   */
  async removeCtrlProxyPortForward(
    port: number,
    signal?: AbortSignal,
    options: { reclaimUnrecorded?: boolean } = {},
  ): Promise<boolean> {
    try {
      const expectedLocal = `tcp:${port}`;
      if (!(await this.hasCtrlProxyPortForward(port, signal))) {
        this.markCtrlProxyPortForwardGone(port);
        return true;
      }
      if (this.context.forwardLeaseForceReleased) {
        // Shutdown gave this client's lease away while its close was stuck; a
        // successor may already own a forward on this port (#10690).
        logger.warn(
          `[CTRL_PROXY] Leaving CtrlProxy forward on ${this.context.deviceId} tcp:${port} in place: ` +
            `this client's forwarding lease was released before its close finished`,
        );
        return false;
      }
      if (options.reclaimUnrecorded !== true && !this.ownsCtrlProxyPortForward(port)) {
        // Never remove or replace another daemon's forward (#10690).
        logger.warn(
          `[CTRL_PROXY] Leaving CtrlProxy forward on ${this.context.deviceId} tcp:${port} in place: ` +
            `this process did not create it`,
        );
        return false;
      }

      this.assertNoLiveRememberedForeignForward(port);
      await this.context.adb.execute(["forward", "--remove", expectedLocal], { signal });
      const startedAt = this.context.timer.now();
      const confirmationDeadlineMs = 2_000;
      const backoff = exponentialBackoff({ initialDelayMs: 100, maxDelayMs: 800 });
      for (let attempt = 1; ; attempt++) {
        if (!(await this.hasCtrlProxyPortForward(port, signal))) {
          this.markCtrlProxyPortForwardGone(port);
          return true;
        }
        const remainingMs = confirmationDeadlineMs - (this.context.timer.now() - startedAt);
        if (remainingMs <= 0) {
          break;
        }
        await this.context.timer.sleep(Math.min(backoff.delayForAttempt(attempt), remainingMs));
      }
      logger.warn(
        `[CTRL_PROXY] CtrlProxy forward on ${this.context.deviceId} tcp:${port} remained after removal confirmation`,
      );
      PortManager.quarantine(port);
      return false;
    } catch (error) {
      if (error instanceof CtrlProxyForwardingLeaseConflictError) {
        throw error;
      }
      logger.warn(
        `[CTRL_PROXY] Failed to remove CtrlProxy forward on ${this.context.deviceId} tcp:${port}: ${error}`,
        error,
      );
      return false;
    }
  }

  assertNoLiveRememberedForeignForward(port: number): void {
    if (this.ownsCtrlProxyPortForward(port)) {
      return;
    }
    const pids = liveRememberedForwardClients(
      this.context.deviceId,
      port,
      this.context.forwardClientProcessIsRunning,
    );
    if (pids.length > 0) {
      this.throwForeignCtrlProxyForwards(
        [port],
        { clientPidsByPort: new Map([[port, pids]]) },
        false,
        true,
      );
    }
  }

  markCtrlProxyPortForwardGone(port: number): void {
    PortManager.clearQuarantine(port);
    if (!this.context.forwardLeaseForceReleased) {
      // After a forced release the record on this port may be a successor's.
      this.context.ctrlProxyForwardLease.forgetOwnedForward?.(port);
    }
  }

  async hasCtrlProxyPortForward(port: number, signal?: AbortSignal): Promise<boolean> {
    const result = await this.context.adb.execute(["forward", "--list"], { signal });
    const expectedLocal = `tcp:${port}`;
    const expectedRemote = `tcp:${PortManager.DEVICE_PORT}`;
    return result.stdout.split(/\r?\n/).some((line) => {
      const forward = this.parseOwnPortForward(line);
      return forward?.local === expectedLocal && forward.remote === expectedRemote;
    });
  }

  parseOwnPortForward(line: string): { local: string; remote: string } | null {
    return parseOwnPortForward(this.context.deviceId, line);
  }

  localPortFromForward(value: string | undefined): number | null {
    return localPortFromForward(value);
  }

  /**
   * Check if port forwarding is still active by querying adb forward --list
   */
  async isPortForwardingActive(signal?: AbortSignal): Promise<boolean> {
    try {
      const result = await this.context.adb.execute(["forward", "--list"], { signal });
      // Format is exactly: "serial tcp:localPort tcp:remotePort". Requiring
      // the serial prevents another device's same-number forward from being
      // mistaken for this client's forward.
      const isActive = result.stdout.split(/\r?\n/).some((line) => {
        const forward = this.parseOwnPortForward(line);
        return (
          forward?.local === `tcp:${this.context.localPort}` &&
          forward.remote === `tcp:${PortManager.DEVICE_PORT}`
        );
      });
      if (!isActive) {
        logger.debug(
          `[CTRL_PROXY] Port forwarding not found for ${this.context.deviceId} on tcp:${this.context.localPort}`,
        );
      }
      return isActive;
    } catch (error) {
      logger.debug(`[CTRL_PROXY] Failed to check port forwarding status: ${error}`);
      return false;
    }
  }
}
