import { ActionableError } from "../../../models/ActionableError";
import type { Timer } from "../../../utils/SystemTimer";
import { BufferedViewerClient } from "./BufferedViewerClient";
import { HandshakeReplaySocket } from "./HandshakeReplaySocket";
import { connectPrototypeAgent, type PrototypeAgentConnector } from "./prototypeAgentClient";

/** Subscribe before releasing replay, including hello and events received in one socket chunk. */
export async function connectBufferedPrototypeAgent(
  port: number,
  token: string,
  connector: PrototypeAgentConnector,
  timer: Timer,
): Promise<BufferedViewerClient> {
  const socket = new HandshakeReplaySocket(await connector.connect(port));
  try {
    const raw = await connectPrototypeAgent({
      port,
      token,
      connector: { connect: async () => socket },
      timer,
    });
    const buffered = new BufferedViewerClient(raw);
    socket.release();
    return buffered;
  } catch {
    socket.end();
    // Never retain an authentication error cause: an endpoint could echo the secret.
    throw new ActionableError(
      "Prototype viewer authentication failed; reopen the viewer and retry.",
    );
  }
}
