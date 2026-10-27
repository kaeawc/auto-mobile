import { createTestUnixSocketServer } from "./createTestUnixSocketServer";
import type { UnixSocketServer } from "../../src/daemon/socketServer";
import type { Timer } from "../../src/utils/SystemTimer";
const unexpectedState = (): never => {
  throw new Error("Unexpected daemon state access");
};
const uninitializedState: ConstructorParameters<typeof UnixSocketServer>[1] = {
  isInitialized: () => false,
  getSessionManager: unexpectedState,
  getDevicePool: unexpectedState,
  getDeviceSessionRegistry: unexpectedState,
};
/** Real collaborators with in-memory state; no listener, database, or lifecycle is started. */
export function socketServerInputHooks(timer: Timer) {
  return createTestUnixSocketServer("unused", uninitializedState, timer).testHooks.input;
}
