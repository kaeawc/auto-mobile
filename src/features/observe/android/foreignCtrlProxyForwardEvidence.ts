import { PortManager } from "../../../utils/PortManager";
import { logger } from "../../../utils/logger";
import { errorMessage } from "../../../utils/describeUnknownError";
import { isProcessRunning } from "../../../utils/processLiveness";
import { defaultTimer, type Timer } from "../../../utils/SystemTimer";
import {
  defaultAdbClientFactory,
  type AdbClientFactory,
} from "../../../utils/android-cmdline-tools/AdbClientFactory";
import { FileCtrlProxyForwardLease } from "./CtrlProxyForwardLease";
import {
  HostForwardClientConnectionProbe,
  type ForwardClientConnectionProbe,
} from "./CtrlProxyForwardClientProbe";

export { CtrlProxyForwardOwnershipUnreadableError } from "../../../models/CtrlProxyForwardOwnershipUnreadableError";

import type {
  ForeignCtrlProxyForwardEvidence,
  ForeignCtrlProxyForwardVerdict,
} from "../../../models/ForeignCtrlProxyForwardEvidence";
export type { ForeignCtrlProxyForwardEvidence, ForeignCtrlProxyForwardVerdict };

/** Process-wide: losing a socket never establishes that its live owner has gone (#12220). */
const rememberedClients = new Map<string, Map<number, Set<number>>>();

export function resetForeignCtrlProxyForwardEvidenceForTesting(): void {
  rememberedClients.clear();
}

export function rememberForeignForwardClients(
  deviceId: string,
  port: number,
  pids: readonly number[],
): void {
  const foreign = pids.filter((pid) => pid !== process.pid && pid > 0);
  if (foreign.length === 0) {
    return;
  }
  let ports = rememberedClients.get(deviceId);
  if (!ports) {
    ports = new Map();
    rememberedClients.set(deviceId, ports);
  }
  ports.set(port, new Set([...(ports.get(port) ?? []), ...foreign]));
}

export function pruneForeignForwardMemory(
  deviceId: string,
  unrecordedPorts: ReadonlySet<number>,
): void {
  const ports = rememberedClients.get(deviceId);
  for (const port of ports?.keys() ?? []) {
    if (!unrecordedPorts.has(port)) {
      ports?.delete(port);
    }
  }
  if (ports?.size === 0) {
    rememberedClients.delete(deviceId);
  }
}

export function liveRememberedForwardClients(
  deviceId: string,
  port: number,
  alive: (pid: number) => boolean = isProcessRunning,
): number[] {
  const ports = rememberedClients.get(deviceId);
  const pids = [...(ports?.get(port) ?? [])].filter(alive);
  if (pids.length === 0) {
    ports?.delete(port);
  } else {
    ports?.set(port, new Set(pids));
  }
  if (ports?.size === 0) {
    rememberedClients.delete(deviceId);
  }
  return pids;
}

/** Exact ADB row contract, shared with forward cleanup. */
export function parseOwnPortForward(
  deviceId: string,
  line: string,
): { local: string; remote: string } | null {
  const [serial, local, remote, ...extra] = line.trim().split(/\s+/);
  if (serial !== deviceId) {
    return null;
  }
  if (extra.length !== 0) {
    logger.debug(
      `[CTRL_PROXY] Skipping adb forward row with extra columns for ${serial}: ${line.trim()}`,
    );
    return null;
  }
  return local && remote ? { local, remote } : null;
}

export function localPortFromForward(value: string | undefined): number | null {
  if (value === undefined || !value.startsWith("tcp:")) {
    return null;
  }
  const port = Number.parseInt(value.slice("tcp:".length), 10);
  return Number.isInteger(port) && port > 0 ? port : null;
}

export function listedCtrlProxyForwardPorts(deviceId: string, stdout: string): Set<number> {
  const ports = new Set<number>();
  for (const line of stdout.split(/\r?\n/)) {
    const forward = parseOwnPortForward(deviceId, line);
    if (!forward || forward.remote !== `tcp:${PortManager.DEVICE_PORT}`) {
      continue;
    }
    const port = localPortFromForward(forward.local);
    if (port !== null) {
      ports.add(port);
    }
  }
  return ports;
}

export interface ForeignForwardEvidenceDependencies {
  adbFactory: AdbClientFactory;
  clientProbe: ForwardClientConnectionProbe;
  ownership: (deviceId: string) => {
    ownsForward(port: number): boolean;
    ownershipDirectory?(): string;
  };
  isProcessRunning: (pid: number) => boolean;
  timer: Timer;
}

export class DefaultForeignCtrlProxyForwardEvidence implements ForeignCtrlProxyForwardEvidence {
  private listingInFlight?: { deviceId: string; result: Promise<{ stdout: string }> };

  constructor(private readonly deps: ForeignForwardEvidenceDependencies) {}

  private listForwards(deviceId: string, signal?: AbortSignal): Promise<{ stdout: string }> {
    const list = () =>
      this.deps.adbFactory
        .create({ deviceId, name: deviceId, platform: "android" })
        .execute(["forward", "--list"], { signal });
    // Cancellation belongs to one caller; only signal-less inventory reads coalesce.
    if (signal) {
      return list();
    }
    if (!this.listingInFlight) {
      this.listingInFlight = {
        deviceId,
        result: list().finally(() => {
          this.listingInFlight = undefined;
        }),
      };
    }
    const listing = this.listingInFlight;
    return listing.result.catch((error: unknown) => {
      if (listing.deviceId === deviceId) {
        throw error;
      }
      logger.warn(
        `[CTRL_PROXY] Shared forward listing from ${listing.deviceId} failed; retrying on ${deviceId}`,
        error,
      );
      return list();
    });
  }

  async read(deviceId: string, signal?: AbortSignal): Promise<ForeignCtrlProxyForwardVerdict> {
    let ports: number[] = [];
    let ownershipDirectory: string | undefined;
    try {
      signal?.throwIfAborted();
      const { stdout } = await this.listForwards(deviceId, signal);
      signal?.throwIfAborted();
      const listed = listedCtrlProxyForwardPorts(deviceId, stdout);
      if (listed.size === 0) {
        pruneForeignForwardMemory(deviceId, listed);
        return { kind: "none" };
      }
      ports = [...listed];
      const ownership = this.deps.ownership(deviceId);
      ownershipDirectory = ownership.ownershipDirectory?.();
      ports = ports.filter((port) => !ownership.ownsForward(port));
      pruneForeignForwardMemory(deviceId, new Set(ports));
      if (ports.length === 0) {
        return { kind: "none" };
      }
      const connected = await Promise.all(
        ports.map(async (port) => {
          const pids = (await this.deps.clientProbe.findClientPids(port, signal)).filter(
            (pid) => pid !== process.pid && pid > 0,
          );
          signal?.throwIfAborted();
          rememberForeignForwardClients(deviceId, port, pids);
          return pids;
        }),
      );
      const clientPids = [
        ...new Set([
          ...connected.flat(),
          ...ports.flatMap((port) =>
            liveRememberedForwardClients(deviceId, port, this.deps.isProcessRunning),
          ),
        ]),
      ];
      if (clientPids.length === 0) {
        return { kind: "none" };
      }
      return {
        kind: "foreign",
        ports,
        clientPids,
        message: describeForeignCtrlProxyForwards(deviceId, ports, ownershipDirectory, {
          clientPids,
          rememberedOnly: connected.flat().length === 0,
        }),
      };
    } catch (error) {
      signal?.throwIfAborted();
      if (error instanceof Error && error.name === "AbortError") {
        throw error;
      }
      const reason = errorMessage(error);
      logger.warn(
        `[CTRL_PROXY] Could not establish forward ownership on ${deviceId}: ${reason}`,
        error,
      );
      return {
        kind: "unknown",
        ports,
        reason,
        message: describeForeignCtrlProxyForwards(deviceId, ports, ownershipDirectory, {
          probeFailure: reason,
        }),
      };
    }
  }
}

/** Lazy construction: neither the factory nor a host probe runs until read(). */
export function createForeignCtrlProxyForwardEvidence(
  adbFactory: AdbClientFactory = defaultAdbClientFactory,
): ForeignCtrlProxyForwardEvidence {
  const timer = defaultTimer;
  return new DefaultForeignCtrlProxyForwardEvidence({
    adbFactory,
    clientProbe: new HostForwardClientConnectionProbe(),
    ownership: (deviceId) => new FileCtrlProxyForwardLease(deviceId, { timer }),
    isProcessRunning,
    timer,
  });
}

/**
 * Actionable message for CtrlProxy forwards on a device that no process in this
 * coordination directory created and that another process may still use (issue
 * #10690). `evidence` says why the forward was judged live: connected client
 * PIDs, or a host TCP-table read that failed and so cannot rule a client out.
 */
export function describeForeignCtrlProxyForwards(
  deviceId: string,
  ports: number[],
  ownershipDirectory: string | undefined,
  evidence: { clientPids: number[]; rememberedOnly?: boolean } | { probeFailure: string },
): string {
  const listed = ports.map((port) => `tcp:${port}`).join(", ");
  const removal = ports
    .map((port) => `\`adb -s ${deviceId} forward --remove tcp:${port}\``)
    .join(", ");
  const domain = ownershipDirectory === undefined ? "" : ` (records in ${ownershipDirectory})`;
  const unrecorded =
    `its CtrlProxy forward ${listed} was not created by this daemon (PID ${process.pid}) or ` +
    `any daemon sharing its coordination directory${domain}`;
  if ("clientPids" in evidence) {
    const pids = evidence.clientPids.join(", ");
    const connection = evidence.rememberedOnly
      ? "was seen connected to it and is still running"
      : "holds a connection to it";
    return (
      `${deviceId} is driven by another AutoMobile daemon: ${unrecorded}, and PID ${pids} ` +
      `${connection}, so it was left in place. An older AutoMobile release or a ` +
      `daemon started with a different AUTOMOBILE_COORDINATION_DIR is the usual owner; stop ` +
      `it (\`kill ${evidence.clientPids[0]}\`) or use another device.`
    );
  }
  return (
    `${deviceId} may be driven by another AutoMobile daemon: ${unrecorded}, and its host ` +
    `connections could not be checked (${evidence.probeFailure}), so it was left in place. ` +
    `If no other AutoMobile daemon uses this device, remove the stale forward with ` +
    `${removal} and retry.`
  );
}
