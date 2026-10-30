import { AMBIENT_ENV, readEnvRaw } from "../config/env";

const DEFAULT_ADB_SERVER_HOST = "localhost";
const DEFAULT_ADB_SERVER_PORT = "5037";
const LOOPBACK_ADB_HOSTS = new Set(["localhost", "127.0.0.1", "::1", "[::1]"]);

/** A file-name-safe key for one ADB server endpoint; loopback spellings share one key. */
function tcpServerScope(host: string, port: string): string {
  const canonicalHost = LOOPBACK_ADB_HOSTS.has(host.toLowerCase())
    ? DEFAULT_ADB_SERVER_HOST
    : host.toLowerCase();
  return `tcp-${canonicalHost}-${port}`.replace(/[^A-Za-z0-9.-]/g, "_");
}

/**
 * Identifies the ADB server this process's `adb` talks to, from the variables adb itself reads:
 * `ADB_SERVER_SOCKET` (`tcp:<port>`, `tcp:<host>:<port>`, or another socket spec), else
 * `ANDROID_ADB_SERVER_ADDRESS` and `ANDROID_ADB_SERVER_PORT` (default `localhost:5037`).
 * Daemons sharing a server see the same devices, so they must share its claims (#10708).
 */
export function adbServerScope(env: NodeJS.ProcessEnv = process.env): string {
  const socket = readEnvRaw(AMBIENT_ENV.ADB_SERVER_SOCKET, env)?.trim();
  if (socket) {
    if (socket.startsWith("tcp:")) {
      const endpoint = socket.slice("tcp:".length);
      const separator = endpoint.lastIndexOf(":");
      return separator < 0
        ? tcpServerScope(DEFAULT_ADB_SERVER_HOST, endpoint)
        : tcpServerScope(endpoint.slice(0, separator), endpoint.slice(separator + 1));
    }
    return `socket-${Buffer.from(socket).toString("base64url")}`;
  }
  return tcpServerScope(
    readEnvRaw(AMBIENT_ENV.ANDROID_ADB_SERVER_ADDRESS, env)?.trim() || DEFAULT_ADB_SERVER_HOST,
    readEnvRaw(AMBIENT_ENV.ANDROID_ADB_SERVER_PORT, env)?.trim() || DEFAULT_ADB_SERVER_PORT,
  );
}
