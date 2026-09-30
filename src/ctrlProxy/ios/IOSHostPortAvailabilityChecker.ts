import { createConnection } from "node:net";

/**
 * Decides whether a TCP host:port is free to bind for a CtrlProxy iOS runner.
 *
 * Extracted from {@link IOSCtrlProxyManager} (issue #3218) so host-port
 * availability decisions live in one focused, injectable collaborator instead of
 * inline in the manager. The manager re-exports this interface for backward
 * compatibility with existing consumers/tests.
 */
export interface HostPortAvailabilityChecker {
  isAvailable(host: string, port: number): Promise<boolean>;
}

/**
 * Real {@link HostPortAvailabilityChecker} backed by a short-lived TCP connect
 * probe. A port is treated as available only when the connect is actively
 * refused (`ECONNREFUSED`); a successful connect or a timeout means something is
 * (or may be) listening, so the port is treated as unavailable.
 */
export class TcpHostPortAvailabilityChecker implements HostPortAvailabilityChecker {
  private static readonly CONNECT_TIMEOUT_MS = 1000;

  public isAvailable(host: string, port: number): Promise<boolean> {
    return new Promise((resolve) => {
      const socket = createConnection({ host, port });
      let settled = false;

      const finish = (available: boolean) => {
        if (settled) {
          return;
        }
        settled = true;
        socket.destroy();
        resolve(available);
      };

      socket.setTimeout(TcpHostPortAvailabilityChecker.CONNECT_TIMEOUT_MS);
      socket.once("connect", () => finish(false));
      socket.once("timeout", () => finish(false));
      socket.once("error", (error) => {
        const code = (error as NodeJS.ErrnoException).code;
        finish(code === "ECONNREFUSED");
      });
    });
  }
}
