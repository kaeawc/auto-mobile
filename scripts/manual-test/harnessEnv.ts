import { isAbsolute, resolve, relative, sep } from "node:path";
import { resolveDaemonStatePath } from "../../src/daemon/constants";
import { resolveAutoMobileBaseDir } from "../../src/utils/tempDir";
import { resolveAuxSocketDir } from "../../src/daemon/socketServer/SocketServerTypes";
import type { HostDefaults } from "./privateDaemonEnv";

/** Stronger than mcp-drive's privateEnvError: also checks the socket and host defaults.
 * Kept independent of its CLI/tool-registry imports for a pure harness boundary. */
export function privateHarnessEnvRefusal(
  env: Record<string, string | undefined>,
  host: HostDefaults,
): string | undefined {
  const aux = env.AUTOMOBILE_AUX_SOCKET_DIR?.trim();
  const socket = env.AUTOMOBILE_DAEMON_SOCKET_PATH?.trim();
  if (
    !aux ||
    !socket ||
    !isAbsolute(aux) ||
    !isAbsolute(socket) ||
    !env.MT_SERVER?.trim() ||
    aux.includes("\0") ||
    socket.includes("\0")
  ) {
    return "Private harness env requires absolute AUTOMOBILE_AUX_SOCKET_DIR and AUTOMOBILE_DAEMON_SOCKET_PATH plus MT_SERVER; source the private daemon env first.";
  }
  if (resolve(socket) === resolve(resolveDaemonStatePath("sock", {}, String(host.uid)))) {
    return "Refusing the resident daemon socket; source a private daemon env.";
  }
  for (const home of host.homeDirs) {
    const base = resolveAutoMobileBaseDir({}, home, home);
    const roots = [base, resolveAuxSocketDir({ AUTOMOBILE_AUX_SOCKET_DIR: base })];
    for (const root of roots) {
      for (const value of [aux, socket]) {
        const rel = relative(root, resolve(value));
        if (rel === "" || (rel !== ".." && !rel.startsWith(`..${sep}`) && !isAbsolute(rel))) {
          return "Refusing the default auxiliary socket directory; source a private daemon env.";
        }
      }
    }
  }
  return undefined;
}
