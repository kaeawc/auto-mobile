import { Timer, defaultTimer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { RequestResponseSocketServer, getSocketPath } from "./socketServer/index";
import { WEBRTC_STREAM_SOCKET_CONFIG } from "./daemonFiles";
import { ActionableError, type BootedDevice } from "../models";
import { DeviceSessionManager } from "../utils/DeviceSessionManager";
import {
  getWebRtcStreamDescriptor,
  listWebRtcStreams,
  startWebRtcStream,
  stopWebRtcStream,
} from "../server/webrtcStreamManager";
import type {
  WebRtcStreamSocketRequest,
  WebRtcStreamSocketResponse,
} from "./webrtcStreamSocketTypes";
import type { WebRtcStreamingOverrides } from "../features/webrtc";

/** Injectable dependencies so the server can be tested without a device pool. */
export interface WebRtcStreamSocketServerDependencies {
  resolveDevice: (deviceId?: string, platform?: "android" | "ios") => Promise<BootedDevice>;
  startStream: typeof startWebRtcStream;
  stopStream: typeof stopWebRtcStream;
  listStreams: typeof listWebRtcStreams;
  getStream: typeof getWebRtcStreamDescriptor;
}

async function defaultResolveDevice(
  deviceId?: string,
  platform: "android" | "ios" = "android"
): Promise<BootedDevice> {
  const devices = await DeviceSessionManager.getInstance().detectConnectedPlatforms();
  const candidates = devices.filter(device => device.platform === platform);

  if (deviceId) {
    const match = candidates.find(device => device.deviceId === deviceId);
    if (!match) {
      throw new ActionableError(`No connected ${platform} device with id ${deviceId}.`);
    }
    return match;
  }

  if (candidates.length === 0) {
    throw new ActionableError(`No connected ${platform} devices found.`);
  }
  if (candidates.length > 1) {
    throw new ActionableError(
      `Multiple connected ${platform} devices; specify deviceId. Found: ${candidates
        .map(device => device.deviceId)
        .join(", ")}`
    );
  }
  return candidates[0];
}

const defaultDependencies: WebRtcStreamSocketServerDependencies = {
  resolveDevice: defaultResolveDevice,
  startStream: startWebRtcStream,
  stopStream: stopWebRtcStream,
  listStreams: listWebRtcStreams,
  getStream: getWebRtcStreamDescriptor,
};

/**
 * Unix-socket control plane for WebRTC screen streaming. A CI worker (or IDE)
 * connects to `~/.auto-mobile/webrtc-stream.sock` and sends newline-delimited
 * JSON requests to start, stop, or inspect live WHIP streams. This keeps stream
 * control in the long-lived daemon rather than the per-call MCP surface.
 */
export class WebRtcStreamSocketServer extends RequestResponseSocketServer<
  WebRtcStreamSocketRequest,
  WebRtcStreamSocketResponse
> {
  private readonly deps: WebRtcStreamSocketServerDependencies;

  constructor(
    socketPath: string = getSocketPath(WEBRTC_STREAM_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    deps: WebRtcStreamSocketServerDependencies = defaultDependencies
  ) {
    super(socketPath, timer, "WebRtcStream");
    this.deps = deps;
  }

  protected async handleRequest(
    request: WebRtcStreamSocketRequest
  ): Promise<WebRtcStreamSocketResponse> {
    switch (request.action) {
      case "start":
        return this.handleStart(request);
      case "stop": {
        const stream = await this.deps.stopStream(request.streamId);
        return { id: request.id, success: true, type: "webrtc_stream_response", action: "stop", stream };
      }
      case "status":
        return this.handleStatus(request);
      case "list":
        return {
          id: request.id,
          success: true,
          type: "webrtc_stream_response",
          action: "list",
          streams: this.deps.listStreams(),
        };
      default:
        throw new ActionableError(`Unsupported webrtcStream action: ${request.action}`);
    }
  }

  private async handleStart(
    request: WebRtcStreamSocketRequest
  ): Promise<WebRtcStreamSocketResponse> {
    const device = await this.deps.resolveDevice(request.deviceId, request.platform ?? "android");
    const overrides: WebRtcStreamingOverrides = {};
    if (request.whipEndpoint) {
      overrides.whipEndpoint = request.whipEndpoint;
    }
    if (request.whipToken) {
      overrides.bearerToken = request.whipToken;
    }
    if (request.iceServers && request.iceServers.length > 0) {
      overrides.iceServers = request.iceServers;
    }
    if (request.bitrateKbps !== undefined) {
      overrides.bitrateKbps = request.bitrateKbps;
    }
    if (request.size) {
      overrides.size = request.size;
    }

    const stream = await this.deps.startStream({ device, streamId: request.streamId, overrides });
    logger.info(`[WebRtcStream] started stream ${stream.streamId} for device ${device.deviceId}`);
    return { id: request.id, success: true, type: "webrtc_stream_response", action: "start", stream };
  }

  private handleStatus(request: WebRtcStreamSocketRequest): WebRtcStreamSocketResponse {
    if (request.streamId) {
      const stream = this.deps.getStream(request.streamId);
      if (!stream) {
        throw new ActionableError(`No active WebRTC stream with id ${request.streamId}.`);
      }
      return { id: request.id, success: true, type: "webrtc_stream_response", action: "status", stream };
    }
    return {
      id: request.id,
      success: true,
      type: "webrtc_stream_response",
      action: "list",
      streams: this.deps.listStreams(),
    };
  }

  protected createErrorResponse(id: string | undefined, error: string): WebRtcStreamSocketResponse {
    return { id, success: false, type: "webrtc_stream_response", error };
  }
}

let socketServer: WebRtcStreamSocketServer | null = null;

export function getWebRtcStreamSocketPath(): string {
  return socketServer?.getSocketPath() ?? getSocketPath(WEBRTC_STREAM_SOCKET_CONFIG);
}

export async function startWebRtcStreamSocketServer(): Promise<void> {
  if (!socketServer) {
    socketServer = new WebRtcStreamSocketServer();
  }
  if (!socketServer.isListening()) {
    await socketServer.start();
  }
}

export async function stopWebRtcStreamSocketServer(): Promise<void> {
  if (!socketServer) {
    return;
  }
  await socketServer.close();
  socketServer = null;
}
