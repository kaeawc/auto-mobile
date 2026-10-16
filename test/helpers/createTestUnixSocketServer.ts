import { UnixSocketServer, type SocketReclaimLock } from "../../src/daemon/socketServer";

export const fakeBindLock: SocketReclaimLock = {
  acquire: () => true,
  release: () => {},
};

/**
 * Avoid the cold defaultLockOwnerGenerationProbe (~250 ms), which exceeds the
 * 100 ms unit-test budget. Real bind-lock behaviour is covered by
 * test/daemon/socketServerBindGuard.integration.test.ts.
 */
export function createTestUnixSocketServer(
  ...args: ConstructorParameters<typeof UnixSocketServer>
): UnixSocketServer {
  return new UnixSocketServer(
    args[0],
    args[1],
    args[2],
    args[3],
    args[4],
    args[5],
    args[6],
    { bindLock: fakeBindLock, ...(args[7] ?? {}) },
    args[8],
  );
}
