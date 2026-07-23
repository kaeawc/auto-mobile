import { Timer, defaultTimer } from "../utils/SystemTimer";
import { logger } from "../utils/logger";
import { RequestResponseSocketServer, getSocketPath } from "./socketServer/index";
import { WEBRTC_STREAM_SOCKET_CONFIG } from "./daemonFiles";
import { ActionableError, type BootedDevice } from "../models";
import {
  MultiPlatformDeviceManager,
  type PlatformDeviceManager,
} from "../utils/deviceUtils";
import type {
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

/**
 * Lazily import the stream manager (which pulls in werift) only when a request
 * actually arrives, so the daemon does not load the heavy WebRTC stack at boot.
 */
function loadManager() {
  return import("../server/webrtcStreamManager");
}

export async function resolveWebRtcStreamDevice(
  deviceManager: Pick<PlatformDeviceManager, "getBootedDevices">,
  deviceId?: string,
  platform: "android" | "ios" = "android"
): Promise<BootedDevice> {
  // The request already names its platform. Querying both platforms makes an
  // iOS stream wait for ADB (and vice versa), so keep discovery platform-scoped.
  const candidates = await deviceManager.getBootedDevices(platform);

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

const defaultDeviceManager = new MultiPlatformDeviceManager();

async function defaultResolveDevice(
  deviceId?: string,
  platform: "android" | "ios" = "android"
): Promise<BootedDevice> {
  return resolveWebRtcStreamDevice(defaultDeviceManager, deviceId, platform);
}

/**
 * Unix-socket control plane for WebRTC screen streaming. A CI worker (or IDE)
 * connects to `~/.auto-mobile/webrtc-stream.sock` and sends newline-delimited
 * JSON requests to start, stop, or inspect live WHIP streams. This keeps stream
 * control in the long-lived daemon rather than the per-call MCP surface.
 *
 * The stream manager (and its werift dependency) is imported lazily on the first
 * request so the daemon does not load the WebRTC stack at boot.
 */
export class WebRtcStreamSocketServer extends RequestResponseSocketServer<
  WebRtcStreamSocketRequest,
  WebRtcStreamSocketResponse
> {
  private readonly injectedDeps?: WebRtcStreamSocketServerDependencies;
  private resolvedDeps: WebRtcStreamSocketServerDependencies | null = null;

  constructor(
    socketPath: string = getSocketPath(WEBRTC_STREAM_SOCKET_CONFIG),
    timer: Timer = defaultTimer,
    deps?: WebRtcStreamSocketServerDependencies
  ) {
    super(socketPath, timer, "WebRtcStream");
    this.injectedDeps = deps;
  }

  /** Resolve dependencies, lazily loading the (werift-heavy) manager on first use. */
  private async getDeps(): Promise<WebRtcStreamSocketServerDependencies> {
    if (this.injectedDeps) {
      return this.injectedDeps;
    }
    if (!this.resolvedDeps) {
      const manager = await loadManager();
      this.resolvedDeps = {
        resolveDevice: defaultResolveDevice,
        startStream: manager.startWebRtcStream,
        stopStream: manager.stopWebRtcStream,
        listStreams: manager.listWebRtcStreams,
        getStream: manager.getWebRtcStreamDescriptor,
      };
    }
    return this.resolvedDeps;
  }

  protected async handleRequest(
    request: WebRtcStreamSocketRequest
  ): Promise<WebRtcStreamSocketResponse> {
    const deps = await this.getDeps();
    switch (request.action) {
      case "start":
        return this.handleStart(deps, request);
      case "stop": {
        const stream = await deps.stopStream(request.streamId);
        return { id: request.id, success: true, type: "webrtc_stream_response", action: "stop", stream };
      }
      case "status":
        return this.handleStatus(deps, request);
      case "list":
        return {
          id: request.id,
          success: true,
          type: "webrtc_stream_response",
          action: "list",
          streams: deps.listStreams(),
        };
      default:
        throw new ActionableError(`Unsupported webrtcStream action: ${request.action}`);
    }
  }

  private async handleStart(
    deps: WebRtcStreamSocketServerDependencies,
    request: WebRtcStreamSocketRequest
  ): Promise<WebRtcStreamSocketResponse> {
    const device = await deps.resolveDevice(request.deviceId, request.platform ?? "android");
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
    if (request.iosSimulatorFps !== undefined) {
      overrides.iosSimulatorFps = request.iosSimulatorFps;
    }
    if (request.audio !== undefined) {
      overrides.audioEnabled = request.audio;
    }

    const stream = await deps.startStream({ device, streamId: request.streamId, overrides });
    logger.info(`[WebRtcStream] started stream ${stream.streamId} for device ${device.deviceId}`);
    return { id: request.id, success: true, type: "webrtc_stream_response", action: "start", stream };
  }

  private handleStatus(
    deps: WebRtcStreamSocketServerDependencies,
    request: WebRtcStreamSocketRequest
  ): WebRtcStreamSocketResponse {
    if (request.streamId) {
      const stream = deps.getStream(request.streamId);
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
      streams: deps.listStreams(),
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
