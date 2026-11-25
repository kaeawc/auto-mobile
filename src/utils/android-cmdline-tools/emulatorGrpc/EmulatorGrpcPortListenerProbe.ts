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

/** Connect errors that mean nothing listens there: refused, or this host has no such loopback. */
const NO_LISTENER_CONNECT_CODES: ReadonlySet<string> = new Set([
  "ECONNREFUSED",
  "EADDRNOTAVAIL",
  "EAFNOSUPPORT",
  "ENETUNREACH",
]);

/**
 * Whether a connect error shows the port is free. Any other error (for example EACCES or EPERM)
 * leaves the listener state unknown, so the caller must not take the port on it.
 */
export function isNoListenerConnectError(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === "string" && NO_LISTENER_CONNECT_CODES.has(code);
}

/** Connect probe of both loopback addresses. Any accepted connection means the port is taken. */
export class TcpEmulatorGrpcPortListenerProbe implements EmulatorGrpcPortListenerProbe {
  async isListening(port: number): Promise<boolean> {
    const results = await Promise.all(LOOPBACK_HOSTS.map((host) => this.accepts(host, port)));
    return results.some(Boolean);
  }

  /**
   * True when the connect succeeds or times out (a loopback listener with a full backlog), false
   * when it is refused or the host lacks that loopback. Any other error rejects: the listener state
   * is unknown, and the caller releases the claim and moves on.
   */
  private accepts(host: string, port: number): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const socket = createConnection({ host, port });
      let settled = false;
      const finish = (listening: boolean | Error) => {
        if (!settled) {
          settled = true;
          socket.destroy();
          if (listening instanceof Error) {
            reject(listening);
          } else {
            resolve(listening);
          }
        }
      };
      socket.setTimeout(CONNECT_TIMEOUT_MS);
      socket.once("connect", () => finish(true));
      socket.once("timeout", () => finish(true));
      socket.once("error", (error) => {
        if (isNoListenerConnectError(error)) {
          // Refused (or no such loopback on this host) is the expected answer for a free port.
          logger.debug(`gRPC port ${port} has no listener on ${host}: ${error.message}`);
          finish(false);
          return;
        }
        finish(
          new Error(`gRPC port ${port} listener check on ${host} failed: ${error.message}`, {
            cause: error,
          }),
        );
      });
    });
  }
}
