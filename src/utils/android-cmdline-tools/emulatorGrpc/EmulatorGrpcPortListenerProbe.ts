import { createConnection } from "node:net";
import { logger } from "../../logger";

/**
 * Whether something already accepts connections on a host gRPC port. A bind probe of 127.0.0.1 and
 * ::1 cannot answer this on macOS: the emulator listens on the IPv6 wildcard (`*:<port>`), and a
 * loopback bind still succeeds beside it (#19188).
 */
export interface EmulatorGrpcPortListenerProbe {
  isListening(port: number): Promise<boolean>;
}

const LOOPBACK_HOSTS = ["127.0.0.1", "::1"] as const;
const CONNECT_TIMEOUT_MS = 1000;

/** Connect probe of both loopback addresses. Any accepted connection means the port is taken. */
export class TcpEmulatorGrpcPortListenerProbe implements EmulatorGrpcPortListenerProbe {
  async isListening(port: number): Promise<boolean> {
    const results = await Promise.all(LOOPBACK_HOSTS.map((host) => this.accepts(host, port)));
    return results.some(Boolean);
  }

  /**
   * True when the connect succeeds or times out (a loopback listener with a full backlog). Any
   * error, including refused or an address family this host lacks, means nothing listens there.
   */
  private accepts(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ host, port });
      let settled = false;
      const finish = (listening: boolean) => {
        if (!settled) {
          settled = true;
          socket.destroy();
          resolve(listening);
        }
      };
      socket.setTimeout(CONNECT_TIMEOUT_MS);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(true));
      socket.once("error", (error) => {
        // Refused (or no such address family) is the expected answer for a free port.
        logger.debug(`gRPC port ${port} has no listener on ${host}: ${error.message}`);
        finish(false);
      });
    });
  }
}
