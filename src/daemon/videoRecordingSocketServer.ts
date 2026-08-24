import { Timer, defaultTimer } from "../utils/SystemTimer";
import { ConfigSocketServer, getSocketPath } from "./socketServer/index";
import {
  getVideoRecordingConfig,
  updateVideoRecordingConfig,
} from "../server/videoRecordingManager";
import { VIDEO_RECORDING_SOCKET_CONFIG } from "./daemonFiles";
import {
  createDefaultStreamSocketAuthenticator,
  type StreamSocketAuthenticator,
} from "./streamSocketAuth";
import type { VideoRecordingConfig, VideoRecordingConfigInput } from "../models";

interface VideoRecordingSocketServerDependencies {
  getConfig: () => Promise<VideoRecordingConfig>;
  updateConfig: (update: VideoRecordingConfigInput | null) => Promise<{
    config: VideoRecordingConfig;
    evictedRecordingIds: string[];
  }>;
}

const defaultDependencies: VideoRecordingSocketServerDependencies = {
  getConfig: getVideoRecordingConfig,
  updateConfig: updateVideoRecordingConfig,
};

/**
 * Socket server for video recording configuration.
 * Handles config/get and config/set requests.
 */
export class VideoRecordingSocketServer extends ConfigSocketServer<
  VideoRecordingConfig,
  VideoRecordingConfigInput,
  "video_recording_request",
  "video_recording_response",
  "evictedRecordingIds"
> {
  constructor(
    socketPath: string = getSocketPath(VIDEO_RECORDING_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    dependencies: VideoRecordingSocketServerDependencies = defaultDependencies,
    authenticator: StreamSocketAuthenticator = createDefaultStreamSocketAuthenticator(
      "videoRecording config/set",
    ),
  ) {
    super({
      socketPath,
      timer,
      serverName: "VideoRecording",
      responseType: "video_recording_response",
      evictedKey: "evictedRecordingIds",
      methodLabel: "video recording",
      getConfig: dependencies.getConfig,
      updateConfig: async (update) => {
        const { config, evictedRecordingIds } = await dependencies.updateConfig(update);
        return { config, evictedItems: evictedRecordingIds };
      },
      authenticator,
    });
  }
}

let socketServer: VideoRecordingSocketServer | null = null;

export function getVideoRecordingSocketPath(): string {
  return socketServer?.getSocketPath() ?? getSocketPath(VIDEO_RECORDING_SOCKET_CONFIG);
}

export async function startVideoRecordingSocketServer(): Promise<void> {
  if (!socketServer) {
    socketServer = new VideoRecordingSocketServer();
  }
  if (!socketServer.isListening()) {
    await socketServer.start();
  }
}

export async function stopVideoRecordingSocketServer(): Promise<void> {
  if (!socketServer) {
    return;
  }
  await socketServer.close();
  socketServer = null;
}
