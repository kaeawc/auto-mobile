import { ActionableError, type BootedDevice } from "../../models";
import { logger } from "../../utils/logger";
import { isIosPhysicalUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import type {
  RecordingHandle,
  RecordingResult,
  VideoCaptureBackend,
  VideoCaptureConfig,
} from "./VideoRecorderService";
import { FfmpegVideoProcessingBackend } from "./FfmpegVideoProcessingBackend";
import { IosPhysicalVideoCaptureBackend } from "./IosPhysicalVideoCaptureBackend";
import { PlatformVideoCaptureBackend } from "./PlatformVideoCaptureBackend";

type HybridBackendKind = "ffmpeg" | "platform" | "ios-physical";

interface HybridBackendHandle {
  kind: "hybrid";
  backend: HybridBackendKind;
  handle: RecordingHandle;
}

export class HybridVideoCaptureBackend implements VideoCaptureBackend {
  private ffmpegBackend: VideoCaptureBackend;
  private platformBackend: VideoCaptureBackend;
  private physicalIosBackend: VideoCaptureBackend;

  constructor(
    ffmpegBackend: VideoCaptureBackend = new FfmpegVideoProcessingBackend(),
    platformBackend: VideoCaptureBackend = new PlatformVideoCaptureBackend(),
    physicalIosBackend: VideoCaptureBackend = new IosPhysicalVideoCaptureBackend(),
  ) {
    this.ffmpegBackend = ffmpegBackend;
    this.platformBackend = platformBackend;
    this.physicalIosBackend = physicalIosBackend;
  }

  async start(config: VideoCaptureConfig): Promise<RecordingHandle> {
    const device = config.device;
    if (!device) {
      throw new ActionableError("Device is required to start video recording.");
    }

    const backend = this.selectBackend(device);
    const handle = await backend.start(config);

    return {
      ...handle,
      backendHandle: {
        kind: "hybrid",
        backend: this.backendKind(backend),
        handle,
      },
    };
  }

  async stop(handle: RecordingHandle): Promise<RecordingResult> {
    const hybridHandle = handle.backendHandle as HybridBackendHandle | undefined;
    if (!hybridHandle || hybridHandle.kind !== "hybrid") {
      throw new Error("Missing backend handle for hybrid video recording.");
    }

    return this.backendFor(hybridHandle.backend).stop(hybridHandle.handle);
  }

  async forceStop(handle: RecordingHandle): Promise<void> {
    const hybridHandle = handle.backendHandle as HybridBackendHandle | undefined;
    if (!hybridHandle || hybridHandle.kind !== "hybrid") {
      throw new Error("Missing backend handle for hybrid video recording.");
    }
    const backend = this.backendFor(hybridHandle.backend);
    if (!backend.forceStop) {
      throw new Error("Selected video capture backend does not support force stopping recordings.");
    }
    await backend.forceStop(hybridHandle.handle);
  }

  private backendKind(backend: VideoCaptureBackend): HybridBackendKind {
    if (backend === this.ffmpegBackend) {
      return "ffmpeg";
    }
    return backend === this.physicalIosBackend ? "ios-physical" : "platform";
  }

  private backendFor(kind: HybridBackendKind): VideoCaptureBackend {
    if (kind === "ffmpeg") {
      return this.ffmpegBackend;
    }
    return kind === "ios-physical" ? this.physicalIosBackend : this.platformBackend;
  }

  private selectBackend(device: BootedDevice): VideoCaptureBackend {
    if (device.platform === "ios") {
      // simctl io recordVideo only drives Simulators, and devicectl has no
      // screen-recording verb, so a physical iPhone/iPad is captured through the
      // CoreMediaIO screen-capture-helper instead (issue #2504).
      return isIosPhysicalUdid(device.deviceId) ? this.physicalIosBackend : this.ffmpegBackend;
    }

    if (device.platform === "android") {
      const useFfmpegPipe =
        process.env.AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE === "1" ||
        process.env.AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE === "true";
      if (useFfmpegPipe) {
        logger.info(
          "[VideoCapture] Android: using exec-out screenrecord → ffmpeg (AUTOMOBILE_ANDROID_VIDEO_USE_FFMPEG_PIPE)",
        );
        return this.ffmpegBackend;
      }
    }

    return this.platformBackend;
  }
}
