import { UnixSocketServer, type SocketReclaimLock } from "../../src/daemon/socketServer";

export const fakeBindLock: SocketReclaimLock = {
  acquire: () => true,
  release: () => {},
};

/**
 * The forward dispatcher a test server gets unless the test passes its own: no MCP server is
 * reachable, as when the daemon's HTTP loopback pointed at an unused endpoint. A test that
 * forwards installs a fake `mcpClientFactory` or passes a real dispatcher.
 */
export const unreachableMcpDispatcher = {
  connect: async (): Promise<never> => {
    throw new Error("No MCP server is reachable from this test socket server");
  },
};

/**
 * Avoid the cold defaultLockOwnerGenerationProbe (~250 ms), which exceeds the
 * 100 ms unit-test budget. Real bind-lock behaviour is covered by
 * test/daemon/socketServerBindGuard.integration.test.ts.
 */
export function createTestUnixSocketServer(
  ...args: ConstructorParameters<typeof UnixSocketServer>
): UnixSocketServer {
  return new UnixSocketServer({
    socketPath: args[0],
    daemonState: args[1],
    timer: args[2],
    featureFlagService: args[3],
    handshakeConfig: { mcpDispatcher: unreachableMcpDispatcher, ...args[4] },
    idGenerator: args[5],
    bindGuard: { bindLock: fakeBindLock, ...(args[6] ?? {}) },
    adbClientFactory: args[7],
  });
}
