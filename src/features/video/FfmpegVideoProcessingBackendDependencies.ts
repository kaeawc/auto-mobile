import type { BootedDevice } from "../../models";
import type { Timer } from "../../utils/SystemTimer";
import type { VideoSimCtl } from "./VideoSimCtl";
import type { FfmpegClient } from "../../utils/media/FfmpegClient";
import { IOSCtrlProxyClient } from "../observe/ios/IOSCtrlProxyClient";
import type { RecordingFileProbe, RecordingFileRemover } from "./ffmpegRecordingFiles";
import type { HostRecorderProcessControl } from "./hostRecorderTeardown";
import type { RecordingCodecProbe } from "./recordingCodec";
export type LiveScreenPixels = (
  device: BootedDevice,
  timeoutMs: number,
) => Promise<{ width: number; height: number } | null>;

export const defaultLiveScreenPixels: LiveScreenPixels = async (device, timeoutMs) => {
  const client = IOSCtrlProxyClient.getInstance(device);
  if (!(await client.ensureConnected())) {
    return null;
  }
  const hierarchy = await client.requestHierarchySyncWithoutObservationStreamPush(
    undefined,
    false,
    undefined,
    timeoutMs,
  );
  const metadata = hierarchy ? client.getScreenScaleMetadata() : null;
  return metadata ? { width: metadata.pixelWidth, height: metadata.pixelHeight } : null;
};

/** Optional collaborators for {@link FfmpegVideoProcessingBackend}; each defaults to the production one. */
export interface FfmpegVideoProcessingBackendDependencies {
  simctlFactory?: (device: BootedDevice) => VideoSimCtl;
  ffmpegClient?: FfmpegClient;
  /** Injectable so hardware-accel detection can be tested for every OS branch on any CI host. */
  platformProvider?: () => NodeJS.Platform;
  /** Injectable so the codec label can be asserted from synthetic files (#4965). */
  codecProbe?: RecordingCodecProbe;
  timer?: Timer;
  /** Injectable so stale-capture cleanup between iOS start attempts avoids the real filesystem. */
  captureFileRemover?: RecordingFileRemover;
  liveScreenPixels?: LiveScreenPixels;
  recordingFileProbe?: RecordingFileProbe;
  readHostStartToken?: (pid: number) => string | undefined;
  hostRecorderControl?: HostRecorderProcessControl;
}
