import type { UnixSocketServer } from "./socketServer";

/** The control-socket members `Daemon` calls. `UnixSocketServer` satisfies it. */
export type DaemonSocketServer = Pick<
  UnixSocketServer,
  | "start"
  | "close"
  | "quiesce"
  | "isListening"
  | "evictDeviceInputCache"
  | "getClientConnectionCount"
  | "getAcceptedClientConnectionCount"
  | "drainSessionReleaseNotifications"
  | "liftSessionlessStrokesOn"
  | "liftStrokesHeldByOn"
>;

function unexpectedCall(member: keyof DaemonSocketServer): () => never {
  return () => {
    throw new Error(
      `DaemonSocketServer.${member} was called on a test double that did not define it`,
    );
  };
}

/**
 * A complete {@link DaemonSocketServer} from the members a test supplies. Members it leaves out
 * throw when called, like a double that never defined them.
 */
export function daemonSocketServerDouble(
  supplied: Partial<DaemonSocketServer>,
): DaemonSocketServer {
  return {
    start: unexpectedCall("start"),
    close: unexpectedCall("close"),
    quiesce: unexpectedCall("quiesce"),
    isListening: unexpectedCall("isListening"),
    evictDeviceInputCache: unexpectedCall("evictDeviceInputCache"),
    getClientConnectionCount: unexpectedCall("getClientConnectionCount"),
    getAcceptedClientConnectionCount: unexpectedCall("getAcceptedClientConnectionCount"),
    drainSessionReleaseNotifications: unexpectedCall("drainSessionReleaseNotifications"),
    liftSessionlessStrokesOn: unexpectedCall("liftSessionlessStrokesOn"),
    liftStrokesHeldByOn: unexpectedCall("liftStrokesHeldByOn"),
    ...supplied,
  };
}
