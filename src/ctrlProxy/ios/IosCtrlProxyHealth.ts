import type { IosCtrlProxyRuntime } from "./IosCtrlProxyRuntime";
import type { DoctorProbeOptions } from "../../utils/doctorTypes";
import {
  createDoctorDeadline,
  remainingDoctorProbe,
  awaitDoctorProbe,
} from "../../utils/doctorProbe";
import { logger } from "../../utils/logger";
import { PortManager } from "../../utils/PortManager";
import { type CtrlProxyHealthCheckResult } from "./IosCtrlProxyHealthClient";
import { IOS_CTRL_PROXY_DEFAULT_PORT } from "./IosCtrlProxyContracts";

/** Probes device-aware health and discovers answering runner ports for doctor. */
export class IosCtrlProxyHealth {
  constructor(
    private readonly state: Pick<
      IosCtrlProxyRuntime,
      "healthClient" | "servicePort" | "device" | "timer"
    >,
  ) {}

  /** Fresh, device-aware health for status callers that must distinguish transport failure. */
  async checkRunningWithReason(): Promise<CtrlProxyHealthCheckResult> {
    return this.state.healthClient.checkHealthEndpointOnPortForDeviceWithReason(
      this.state.servicePort,
      this.state.device.deviceId,
    );
  }

  /**
   * The primary "is our runner up" gate. Routes through the identity-checked
   * strict identity probe (issue #6415) rather than the loose
   * "any 'ok'/'healthy' body" check, so a foreign or anonymous responder on the
   * service port — a sibling simulator's runner, a stale runner from a previous
   * daemon run, or the Android runner reached through `adb forward` — is never
   * mistaken for this device's runner. Every
   * caller (`isRunning()`, the `start()` short-circuit, `waitForHealthEndpoint`,
   * `checkCtrlProxyProcessLiveness()`) inherits the identity check through this one
   * method.
   */
  async checkHealthEndpoint(): Promise<boolean> {
    return this.state.healthClient.checkHealthEndpointOnPortForDevice(
      this.state.servicePort,
      this.state.device.deviceId,
    );
  }

  /**
   * Read-only doctor discovery. Return the answering host port, never the
   * advertised on-device port, without changing daemon allocation or state.
   */
  async discoverRunnerPort(options: DoctorProbeOptions = {}): Promise<number | null> {
    const deadline = createDoctorDeadline({ ...options, timer: options.timer ?? this.state.timer });
    const candidates = new Set([this.state.servicePort, IOS_CTRL_PROXY_DEFAULT_PORT]);
    const probePort = async (port: number): Promise<boolean> => {
      const remaining = remainingDoctorProbe(deadline.probe);
      const probe = createDoctorDeadline({
        signal: remaining.signal,
        timeoutMs: Math.min(250, remaining.timeoutMs ?? 250),
        timer: remaining.timer,
      });
      try {
        return await awaitDoctorProbe(probe.probe, () =>
          this.state.healthClient.checkHealthEndpointOnPortForDevice(
            port,
            this.state.device.deviceId,
            probe.probe.timeoutMs,
            { signal: probe.probe.signal },
          ),
        );
      } catch (error) {
        // An unanswered port is expected; caller cancellation must still stop discovery.
        logger.debug(`[IOSCtrlProxy] Doctor port ${port} probe failed`, error);
        remainingDoctorProbe(deadline.probe);
        return false;
      } finally {
        probe.dispose();
      }
    };
    try {
      for (const port of candidates) {
        if (await probePort(port)) {
          return port;
        }
      }
      const basePort = PortManager.getBasePort();
      // MaxDevices is a count, including the base port; it also reflects END/SIZE env config.
      const endPort = Math.min(65535, basePort + PortManager.getMaxDevices() - 1);
      for (let start = basePort; start <= endPort; start += 4) {
        const ports = Array.from(
          { length: Math.min(4, endPort - start + 1) },
          (_, index) => start + index,
        ).filter((port) => !candidates.has(port));
        const results = await Promise.all(ports.map(probePort));
        const match = ports.find((_, index) => results[index]);
        if (match !== undefined) {
          return match;
        }
      }
      return null;
    } finally {
      deadline.dispose();
    }
  }

  /**
   * Ask the runner what port it is *actually* bound to, by reading the `port`
   * field the runner self-reports in its `/health` payload. Probes the same
   * candidate ports as runner discovery (the allocated service port plus the
   * hardcoded default the runner falls back to).
   *
   * A reported port is only accepted when the runner's `/health` identifies this
   * exact device. This matters because the daemon may probe a port that is
   * answered by a *different* runner — a sibling iOS simulator's runner that fell
   * back to the shared default port (the same #2731 env-propagation failure can
   * also drop the runner's device-id env var), or, on the default port, the
   * Android CtrlProxy reached through its `adb forward`. The Android runner is
   * additionally excluded structurally: its `/health` returns the plain text
   * `OK`, so `JSON.parse` / the strict `status === "ok"` object check rejects it
   * before the device-id guard is even consulted.
   *
   * Returns null when no matching runner answers or when the runner is too old
   * to report a port. This is runner-advertised metadata; doctor uses
   * `discoverRunnerPort()` to find the answering host port instead (#5636).
   */
  async getReportedRunnerPort(): Promise<number | null> {
    const candidatePorts = new Set([this.state.servicePort, IOS_CTRL_PROXY_DEFAULT_PORT]);
    for (const port of candidatePorts) {
      const reportedPort = await this.state.healthClient.readReportedPortFromHealth(port);
      if (reportedPort !== null) {
        return reportedPort;
      }
    }
    return null;
  }

  async checkHealthEndpointOnPortForDevice(
    port: number,
    deviceId: string,
    timeoutMs?: number,
    options?: { requireDeviceId?: boolean },
  ): Promise<boolean> {
    return this.state.healthClient.checkHealthEndpointOnPortForDevice(
      port,
      deviceId,
      timeoutMs,
      options,
    );
  }
}
