import { createConnection } from "node:net";
import { adbServerScope } from "../../utils/adbServerScope";
import { logger } from "../../utils/logger";

/**
 * What a host-side connect to a loopback port showed. `listening`: 127.0.0.1 or ::1 accepted.
 * `refused`: both refused (or ::1 does not exist on this host). `unknown`: anything else (a
 * timeout, an unexpected error), so no decision may rest on it.
 */
export type HostLoopbackState = "listening" | "refused" | "unknown";

/** Connects to a host loopback port the way the adb server does when a reverse is used. */
export interface HostLoopbackProbe {
  probe(port: number): Promise<HostLoopbackState>;
}

/** A probe that never knows: the default for a manager built without host access (tests). */
export const unknownHostLoopbackProbe: HostLoopbackProbe = {
  probe: async () => "unknown",
};

const CONNECT_TIMEOUT_MS = 500;

/** Errors that mean "nothing can be listening at this address". */
const ABSENT_CODES = new Set(["ECONNREFUSED", "EADDRNOTAVAIL", "EAFNOSUPPORT", "ENETUNREACH"]);

type AddressState = "listening" | "absent" | "unknown";

function connectOnce(host: string, port: number): Promise<AddressState> {
  return new Promise((resolve) => {
    const socket = createConnection({ host, port });
    let settled = false;
    const finish = (state: AddressState) => {
      if (!settled) {
        settled = true;
        socket.destroy();
        resolve(state);
      }
    };
    socket.setTimeout(CONNECT_TIMEOUT_MS);
    socket.once("connect", () => finish("listening"));
    socket.once("timeout", () => finish("unknown"));
    socket.once("error", (error: NodeJS.ErrnoException) => {
      if (ABSENT_CODES.has(error.code ?? "")) {
        finish("absent");
        return;
      }
      logger.warn(`[portReverse] host connect to ${host}:${port} failed: ${error.message}`);
      finish("unknown");
    });
  });
}

/**
 * The adb server connects a reverse's `tcp:<port>` target on loopback, IPv4 first and then IPv6,
 * so the target is live when either address accepts and dead only when both are absent.
 */
export const tcpHostLoopbackProbe: HostLoopbackProbe = {
  async probe(port) {
    const states = await Promise.all([connectOnce("127.0.0.1", port), connectOnce("::1", port)]);
    if (states.includes("listening")) {
      return "listening";
    }
    return states.every((state) => state === "absent") ? "refused" : "unknown";
  },
};

/**
 * The probe for the adb server this process uses. A reverse's `tcp:<port>` target is connected
 * by the adb server, so it can be checked from here only when that server is on this host's
 * loopback; any other server (a remote address, a non-TCP socket) gets the probe that never
 * knows, so nothing is reclaimed and `hostListening` is left out.
 */
export function hostLoopbackProbeFor(env: NodeJS.ProcessEnv = process.env): HostLoopbackProbe {
  // The whole endpoint must be loopback: `tcp-localhost-<port>` and nothing else.
  return /^tcp-localhost-\d+$/.test(adbServerScope(env))
    ? tcpHostLoopbackProbe
    : unknownHostLoopbackProbe;
}
