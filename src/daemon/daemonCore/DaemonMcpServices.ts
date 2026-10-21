import type { DeviceReadiness } from "../readiness/DeviceReadiness";
import { DaemonHttpIngress, type DaemonHttpIngressDeps } from "../daemonHttpIngress";
import { createDaemonMcpDispatcher, MCP_FORWARD_CLOSED_REASON } from "../inProcessMcpDispatcher";
import { buildMcpRequestContext, createStatelessMcpServer } from "../statelessMcpServerFactory";
import { createIosDoctorDependencies } from "../../doctor/checks/ios";
import {
  DAEMON_HANDOFF_INTERRUPTED_MESSAGE,
  DaemonHandoffInterruptionError,
} from "../daemonHandoffInterruption";

interface DaemonMcpServicesHost extends Omit<DaemonHttpIngressDeps, "createRequestMcpServer"> {
  deviceReadiness(): DeviceReadiness;
  iosDoctorDependencies: ReturnType<typeof createIosDoctorDependencies>;
  debug(): boolean;
  acceptanceDiscoveryCapability(): string | undefined;
}

/** One doctor probe and dispatcher lifetime shared by the daemon's HTTP and control sockets. */
export class DaemonMcpServices {
  readonly httpIngress: DaemonHttpIngress;
  readonly mcpDispatcher: ReturnType<typeof createDaemonMcpDispatcher>;

  constructor(private readonly host: DaemonMcpServicesHost) {
    this.httpIngress = new DaemonHttpIngress({
      ...host,
      createRequestMcpServer: (req, scope) =>
        createStatelessMcpServer(
          this.statelessMcpServerBase(),
          buildMcpRequestContext({ headers: req.headers }),
          scope,
        ),
    });
    this.mcpDispatcher = createDaemonMcpDispatcher({
      base: () => this.statelessMcpServerBase(),
      idGenerator: { next: () => host.idGenerator().next() },
      closeReason: () =>
        host.isShutdownInProgress()
          ? new DaemonHandoffInterruptionError(DAEMON_HANDOFF_INTERRUPTED_MESSAGE)
          : MCP_FORWARD_CLOSED_REASON,
    });
  }

  private statelessMcpServerBase() {
    return {
      deviceReadiness: this.host.deviceReadiness(),
      iosDependencies: this.host.iosDoctorDependencies,
      debug: this.host.debug(),
      acceptanceDiscoveryCapability: this.host.acceptanceDiscoveryCapability(),
    };
  }
}
