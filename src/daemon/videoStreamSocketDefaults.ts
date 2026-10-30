import { MultiPlatformDeviceManager, type PlatformDeviceManager } from "../devices/deviceUtils";
import { getDefaultDeviceCaptureRegistry } from "../features/webrtc/deviceCaptureRegistry";
import { createH264CaptureSource } from "../features/webrtc/h264CaptureSourceFactory";
import { resolveVideoServerJar } from "../features/webrtc/videoServerJar";
import type { BootedDevice } from "../models";
import { Timer, defaultTimer } from "../utils/SystemTimer";
import { defaultDaemonContext } from "./daemonContext";
import { ObserverReleaseBroadcaster } from "./observerReleaseBroadcast";
import { SessionReleaseBroadcaster } from "./sessionReleaseBroadcast";
import { getDaemonStreamDeviceLifecycleEmitter } from "./streamDeviceLifecycleEvents";
import { resolveStreamDevice } from "./streamDeviceResolver";
import { type VideoStreamSocketServerDependencies } from "./videoStreamSocketSupport";

/** Legacy video requests discover either platform; explicit platform requests stay scoped. */
export async function resolveVideoStreamDevice(
  deviceManager: Pick<PlatformDeviceManager, "getBootedDevices">,
  deviceId?: string,
  platform: "android" | "ios" | "either" = "either",
  timer: Timer = defaultTimer,
  signal?: AbortSignal,
): Promise<BootedDevice> {
  return resolveStreamDevice(deviceManager, deviceId, platform, {
    timer,
    signal,
    source: "video-stream-resolve",
  });
}

export async function defaultResolveDevice(
  deviceManager: Pick<PlatformDeviceManager, "getBootedDevices">,
  deviceId?: string,
  platform?: "android" | "ios",
): Promise<BootedDevice> {
  return resolveVideoStreamDevice(deviceManager, deviceId, platform);
}

export function defaultDependencies(
  deviceManager: Pick<PlatformDeviceManager, "getBootedDevices"> = new MultiPlatformDeviceManager(),
): VideoStreamSocketServerDependencies {
  return {
    captureRegistry: getDefaultDeviceCaptureRegistry(),
    ownershipChanges: () => defaultDaemonContext.sessionManager() ?? null,
    deviceLifecycle: getDaemonStreamDeviceLifecycleEmitter,
    sessionReleases: SessionReleaseBroadcaster,
    observerReleases: ObserverReleaseBroadcaster,
    resolveDevice: (id, platform) => defaultResolveDevice(deviceManager, id, platform),
    createCaptureSource: async (options) => {
      // Resolved once per stream, off the frame path. A null jar means the Android source falls
      // back to `screenrecord`.
      const jarPath = await resolveVideoServerJar();
      return createH264CaptureSource(
        {
          device: options.device,
          onData: options.onData,
          onSourceFrame: options.onSourceFrame,
          onSourceIdle: options.onSourceIdle,
          onEncodedAccessUnit: options.onEncodedAccessUnit,
          onIdleAttestationSupport: options.onIdleAttestationSupport,
          onError: options.onError,
          onRotation: options.onRotation,
          onDroppedFrames: options.onDroppedFrames,
          bitrateBps: options.bitrateBps,
          size: options.size,
          quality: options.quality,
          fps: options.fps,
        },
        jarPath,
      );
    },
    nowUs: () => BigInt(Math.round(performance.now() * 1000)),
  };
}

import { VIDEO_STREAM_SOCKET_CONFIG } from "./daemonFiles";
import { getSocketPath } from "./socketServer/index";
import { createVideoStreamRelaySingleton, type VideoStreamRelay } from "./videoStreamRelay";
export const socketServer = createVideoStreamRelaySingleton();

export function getVideoStreamSocketPath(): string {
  return socketServer.instance?.getSocketPath?.() ?? getSocketPath(VIDEO_STREAM_SOCKET_CONFIG);
}

export function setVideoStreamSocketServerForTesting(server: VideoStreamRelay | null): void {
  socketServer.instance = server;
}

export {
  validateCaptureHints,
  type DeviceOwnershipChanges,
  type VideoStreamSocketServerDependencies,
} from "./videoStreamSocketSupport";
