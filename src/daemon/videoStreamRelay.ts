import { SocketServerSingleton, type SocketServerLifecycle } from "./socketServerSingleton";
import type { VideoStreamSocketServer } from "./videoStreamSocketServer";

/** What the video module wrappers need of the relay, so a test can install a lifecycle double. */
export type VideoStreamRelay = SocketServerLifecycle &
  Partial<Pick<VideoStreamSocketServer, "getSocketPath">>;

export function createVideoStreamRelaySingleton(): SocketServerSingleton<VideoStreamRelay> {
  return new SocketServerSingleton<VideoStreamRelay>();
}
