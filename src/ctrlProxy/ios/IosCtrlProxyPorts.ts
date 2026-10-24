import type { IosCtrlProxyRuntime } from "./IosCtrlProxyRuntime";
import { RemoteServicePortUnavailableError } from "./RemoteServicePortUnavailableError";
import { errorMessage } from "../../utils/describeUnknownError";
import { logger } from "../../utils/logger";
import { IOS_CTRL_PROXY_RESERVED_PORTS, PortManager } from "../../utils/PortManager";
import { ListeningProcess } from "./IosCtrlProxyContracts";

interface IosCtrlProxyPortsHost {
  clearCaches(): void;
  useRemoteRunner(): boolean;
  findListeningProcessesOnPort(port: number): Promise<ListeningProcess[]>;
  isOwnedCtrlProxyRunnerProcess(process: ListeningProcess): boolean;
  findDaemonManagedRunnerTreeRoot(process: ListeningProcess): Promise<number>;
  formatListeningProcesses(processes: ListeningProcess[]): string;
}

/** Allocates host ports, avoids foreign listeners, and reclaims stale owned runners. */
export class IosCtrlProxyPorts {
  constructor(
    private readonly state: Pick<
      IosCtrlProxyRuntime,
      | "device"
      | "servicePort"
      | "tunnelClient"
      | "remoteRunner"
      | "hostPortAvailabilityChecker"
      | "processClient"
    >,
    private readonly host: IosCtrlProxyPortsHost,
  ) {}

  private allocateServicePort(additionalReservedPorts: Iterable<number> = []): number {
    return PortManager.allocate(this.state.device.deviceId, {
      reservedPorts: [...IOS_CTRL_PROXY_RESERVED_PORTS, ...additionalReservedPorts],
    });
  }

  /**
   * Prefer a new endpoint for a forced restart, but retain the retired port as
   * a fallback when the configured range has no spare capacity. The successful
   * runner generation remains the authoritative restart identity when the port
   * must be reused.
   */
  allocateReplacementServicePort(retiredServicePort: number): void {
    PortManager.release(this.state.device.deviceId);
    let replacementPort: number;
    try {
      replacementPort = this.allocateServicePort([retiredServicePort]);
    } catch (error) {
      if (!PortManager.isPortAvailable(retiredServicePort)) {
        throw error;
      }
      // Exhausting a bounded range is safe to recover by reusing the now-free
      // retired port; runnerGeneration distinguishes the replacement.
      logger.debug(
        `[IOSCtrlProxy] No distinct replacement service port is available; reusing ${retiredServicePort}: ${errorMessage(error)}`,
      );
      PortManager.reserve(this.state.device.deviceId, retiredServicePort);
      replacementPort = retiredServicePort;
    }
    if (replacementPort !== retiredServicePort) {
      PortManager.quarantine(retiredServicePort);
    }
    this.state.servicePort = replacementPort;
    this.host.clearCaches();
    logger.info(
      `[IOSCtrlProxy] Allocated replacement service port ${replacementPort} after retiring ${retiredServicePort}`,
    );
  }

  /**
   * True when the port is held by THIS manager's own live tunnel for this device
   * (identified by its recorded PID and forwarded port, never by guessing from the
   * port alone). A bind probe sees that listener as "busy", but it is not a collision
   * (#10232).
   */
  private async isPortHeldByOwnLiveTunnel(port: number): Promise<boolean> {
    if (this.host.useRemoteRunner() || this.state.tunnelClient.localPort !== port) {
      return false;
    }
    return this.state.tunnelClient.isAlive();
  }

  async ensureLocalServicePortAllocatedAndAvailable(): Promise<void> {
    const currentAllocation = PortManager.getPort(this.state.device.deviceId);
    const currentPortIsAvailable =
      PortManager.isPortAvailable(this.state.servicePort) ||
      (await this.isPortHeldByOwnLiveTunnel(this.state.servicePort));
    if (currentAllocation === this.state.servicePort && currentPortIsAvailable) {
      return;
    }

    const additionalReservedPorts = currentPortIsAvailable ? [] : [this.state.servicePort];
    PortManager.release(this.state.device.deviceId);
    const nextPort = this.allocateServicePort(additionalReservedPorts);
    if (nextPort !== this.state.servicePort) {
      logger.info(
        `[IOSCtrlProxy] Reallocated service port from ${this.state.servicePort} to ${nextPort} before runner launch`,
      );
      this.state.servicePort = nextPort;
      this.host.clearCaches();
    }
  }

  adoptServicePort(port: number): void {
    if (PortManager.getPort(this.state.device.deviceId) !== port) {
      PortManager.reserve(this.state.device.deviceId, port);
    }
    if (this.state.servicePort !== port) {
      this.state.servicePort = port;
      this.host.clearCaches();
    }
  }

  async ensureRemoteServicePortAvailable(
    options: { allowReallocation?: boolean } = {},
  ): Promise<void> {
    const allowReallocation = options.allowReallocation ?? true;
    const host = this.state.remoteRunner.getHost();
    const unavailablePorts = new Set<number>();

    for (let attempt = 0; attempt < PortManager.getMaxDevices(); attempt++) {
      if (await this.state.hostPortAvailabilityChecker.isAvailable(host, this.state.servicePort)) {
        return;
      }

      const unavailablePort = this.state.servicePort;
      logger.warn(
        `[IOSCtrlProxy] Remote runner port ${unavailablePort} is already in use on ${host}; reallocating`,
      );
      if (!allowReallocation) {
        throw new RemoteServicePortUnavailableError(host, unavailablePort);
      }
      unavailablePorts.add(unavailablePort);
      PortManager.release(this.state.device.deviceId);
      this.state.servicePort = this.allocateServicePort(unavailablePorts);
    }

    throw new Error(
      `No remote iOS CtrlProxy ports are available for device ${this.state.device.deviceId}.`,
    );
  }

  async ensureServicePortReadyForLaunch(): Promise<void> {
    if (this.host.useRemoteRunner()) {
      return;
    }

    const unavailablePorts = new Set<number>();
    for (let attempt = 0; attempt < PortManager.getMaxDevices(); attempt++) {
      const listeningProcesses = await this.host.findListeningProcessesOnPort(
        this.state.servicePort,
      );
      if (listeningProcesses.length === 0) {
        return;
      }

      const ownedProcesses = listeningProcesses.filter((process) =>
        this.host.isOwnedCtrlProxyRunnerProcess(process),
      );
      if (ownedProcesses.length > 0) {
        for (const process of ownedProcesses) {
          const rootPid = await this.host.findDaemonManagedRunnerTreeRoot(process);
          logger.warn(
            `[IOSCtrlProxy] Terminating stale CtrlProxy process tree rooted at ${rootPid} ` +
              `for listener ${process.pid} on port ${this.state.servicePort}`,
          );
          await this.state.processClient.terminateProcessTree(rootPid).catch((error) => {
            logger.warn(
              `[IOSCtrlProxy] Stale runner tree ${rootPid} survived termination: ${errorMessage(error)}`,
            );
          });
        }

        const remainingProcesses = await this.host.findListeningProcessesOnPort(
          this.state.servicePort,
        );
        if (remainingProcesses.length === 0) {
          return;
        }
        const remainingOwnedProcesses = remainingProcesses.filter((process) =>
          this.host.isOwnedCtrlProxyRunnerProcess(process),
        );
        for (const process of remainingOwnedProcesses) {
          logger.warn(
            `[IOSCtrlProxy] CtrlProxy listener ${process.pid} still holds port ${this.state.servicePort}; ` +
              `force-terminating remaining owned process tree`,
          );
          await this.state.processClient.terminateProcessTree(process.pid).catch((error) => {
            logger.warn(
              `[IOSCtrlProxy] Listener ${process.pid} survived forced termination: ${errorMessage(error)}`,
            );
          });
        }

        const afterForceCleanup = await this.host.findListeningProcessesOnPort(
          this.state.servicePort,
        );
        if (afterForceCleanup.length === 0) {
          return;
        }
        if (afterForceCleanup.some((process) => this.host.isOwnedCtrlProxyRunnerProcess(process))) {
          throw new Error(
            `CtrlProxy recovery failed, port ${this.state.servicePort} still held by ` +
              this.host.formatListeningProcesses(afterForceCleanup),
          );
        }
      }

      unavailablePorts.add(this.state.servicePort);
      logger.warn(
        `[IOSCtrlProxy] Port ${this.state.servicePort} is held by a foreign process; reallocating CtrlProxy port`,
      );
      PortManager.release(this.state.device.deviceId);
      this.state.servicePort = this.allocateServicePort(unavailablePorts);
      this.host.clearCaches();
    }

    throw new Error(
      `No iOS CtrlProxy ports are available for device ${this.state.device.deviceId}.`,
    );
  }
}
