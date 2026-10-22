import type { IosCtrlProxyRuntime } from "./IosCtrlProxyRuntime";
import type { RunnerLaunchProvenance } from "./IosCtrlProxyLifecycleSteps";
import { RemoteServicePortUnavailableError } from "./RemoteServicePortUnavailableError";
import { logger } from "../../utils/logger";
import { IproxyTunnelStartOptions } from "./IosCtrlProxyContracts";

interface IosCtrlProxyTunnelHost {
  isSimulator(): boolean;
  useRemoteRunner(): boolean;
  startIproxyTunnel(options?: IproxyTunnelStartOptions): Promise<void>;
  beginStop(): void;
  stopTrackedService(deadline?: number): Promise<void>;
}

/** Connects and restarts the device tunnel using the current host and runner ports. */
export class IosCtrlProxyTunnel {
  constructor(
    private readonly state: Pick<
      IosCtrlProxyRuntime,
      | "deviceDetector"
      | "tunnelClient"
      | "servicePort"
      | "device"
      | "processSupervisor"
      | "isStopping"
      | "steps"
    >,
    private readonly host: IosCtrlProxyTunnelHost,
  ) {}

  /** Start the iproxy tunnel to the runner. Public so tests can stub the tunnel launch. */
  startIproxyTunnel(options: IproxyTunnelStartOptions = {}): Promise<void> {
    if (this.host.isSimulator()) {
      return Promise.resolve();
    }
    // A supervised restart (allowServicePortReallocation: false) re-establishes a tunnel
    // that already passed this check, so only fresh starts pay for the probe.
    if (!this.host.useRemoteRunner() && options.allowServicePortReallocation !== false) {
      return this.state.deviceDetector
        .assertUsbAttachedForTunnel()
        .then(() => this.startTunnel(options));
    }
    return this.startTunnel(options);
  }

  private startTunnel(options: IproxyTunnelStartOptions): Promise<void> {
    return this.state.tunnelClient.start({
      // Computed ports must follow options: an explicit undefined is not an override.
      ...options,
      localPort: this.state.servicePort,
      devicePort: this.host.useRemoteRunner()
        ? (options.devicePort ?? this.state.tunnelClient.devicePort ?? undefined)
        : this.state.servicePort,
      udid: this.state.device.deviceId,
    });
  }

  stopIproxyTunnel(
    options: { clearDevicePort?: boolean; stopSupervisor?: boolean } = {},
  ): Promise<void> {
    return this.state.tunnelClient.stop(options);
  }

  async restartIproxyTunnel(): Promise<void> {
    try {
      await this.host.startIproxyTunnel({
        allowServicePortReallocation: false,
        devicePort: this.state.tunnelClient.devicePort ?? undefined,
        supervise: false,
      });
    } catch (error) {
      if (!(error instanceof RemoteServicePortUnavailableError)) {
        throw error;
      }
      logger.warn(
        "[IOSCtrlProxy] Existing CtrlProxy process uses a host port that is no longer available during iproxy restart; restarting",
      );
      await this.restartDeviceProcessAfterHostPortCollision();
      await this.state.processSupervisor.start();
    }
  }

  async restartDeviceProcessAfterHostPortCollision(): Promise<RunnerLaunchProvenance> {
    // This replacement runs inside startInternal()'s shared completion, so it must
    // not wait for that same completion through stop() or it would deadlock.
    this.host.beginStop();
    await this.host.stopTrackedService();
    this.state.isStopping = false;
    return this.state.steps.startOnDevice();
  }
}
