export {
  FRAME_HEADER_SIZE,
  FrameDecoder,
  type DecodedFrame,
  type DecodedAudio,
  type FrameHeader,
  type MalformedFrameError,
} from "./frameProtocol";
export {
  IOSScreenCaptureHelper,
  SIMULATOR_FPS_DEFAULT,
  SIMULATOR_FPS_MAX,
  SIMULATOR_FPS_MIN,
  type CaptureTarget,
  type HelperSpawner,
  type IosScreenCaptureHelperOptions,
  type IosScreenCaptureHelperEvents,
} from "./IOSScreenCaptureHelper";
