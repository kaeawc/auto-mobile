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
export class TestUnixSocketServer extends UnixSocketServer {
  /** The frame-context guard input tools run before acting on a device. */
  requireFrameContextForTest(deviceId: string, frameContext: string, action: string): void {
    this.requireCurrentFrameContext(deviceId, frameContext, action);
  }
}

function testServerArgs(
  args: ConstructorParameters<typeof UnixSocketServer>,
): ConstructorParameters<typeof UnixSocketServer> {
  return [
    args[0],
    args[1],
    args[2],
    args[3],
    { mcpDispatcher: unreachableMcpDispatcher, ...args[4] },
    args[5],
    { bindLock: fakeBindLock, ...(args[6] ?? {}) },
    args[7],
  ];
}

export function createTestUnixSocketServer(
  ...args: ConstructorParameters<typeof UnixSocketServer>
): UnixSocketServer {
  return new UnixSocketServer(...testServerArgs(args));
}

/** Like {@link createTestUnixSocketServer}, returning the subclass that exposes connection hooks. */
export function createTestableUnixSocketServer(
  ...args: ConstructorParameters<typeof UnixSocketServer>
): TestUnixSocketServer {
  return new TestUnixSocketServer(...testServerArgs(args));
}
