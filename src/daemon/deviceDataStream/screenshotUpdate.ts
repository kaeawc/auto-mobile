import type { Timer } from "../../utils/SystemTimer";
import type { ScreenshotMetadata } from "../../features/observe/ScreenshotMetadata";
import { readImageHeaderDimensions } from "../../utils/screenshot/imageHeaderDimensions";
import type { DeviceDataStreamMessage, PushScreenshotOptions } from "./streamContracts";

/**
 * Whether a frame's MEASURED pixel dimensions are consistent with the geometry its capture client
 * claimed for it (issue #3348).
 *
 * Either orientation is accepted. Hierarchy geometry is display-oriented while screenshots can
 * arrive in native portrait pixel orientation — the rotation the renderer already corrects for — so
 * a 2532x1170 landscape claim legitimately accompanies a 1170x2532 PNG. Rejecting that would strip
 * the capture identity from every landscape frame on iOS and make device control impossible in that
 * orientation.
 *
 * A swap is still a strong check: it admits exactly one alternative, so a genuine scale change
 * (720x1560 pixels against a 1080x2340 claim) and any unrelated size are both still rejected. An
 * unmeasurable frame is never a match.
 *
 * This is the DAEMON-side pairing check only. A client's LIVE-mirror geometry check stays strict —
 * a mirror frame is always display-oriented, so a swap there means the sources are out of sync.
 */
function pixelsMatchClaimedGeometry(
  measured: { width: number; height: number } | null,
  claimedWidth: number | undefined,
  claimedHeight: number | undefined,
): boolean {
  if (measured === null || claimedWidth === undefined || claimedHeight === undefined) {
    return false;
  }
  const sameOrientation = measured.width === claimedWidth && measured.height === claimedHeight;
  const swappedOrientation = measured.width === claimedHeight && measured.height === claimedWidth;
  return sameOrientation || swappedOrientation;
}

interface ScreenshotUpdateInput {
  deviceId: string;
  screenshotBase64: string;
  screenWidth: number | undefined;
  screenHeight: number | undefined;
  metadata: ScreenshotMetadata;
  options: PushScreenshotOptions;
}

/** Measure captured pixels before stamping their request-bound identity and delivery time. */
export function createScreenshotUpdate(
  {
    deviceId,
    screenshotBase64,
    screenWidth,
    screenHeight,
    metadata,
    options,
  }: ScreenshotUpdateInput,
  timer: Timer,
): DeviceDataStreamMessage {
  const {
    screenshotMimeType,
    screenshotFormat,
    screenshotCaptureSource,
    screenshotFallback,
    screenshotFallbackReason,
    screenshotCaptureDurationMs,
    screenshotEncodeDurationMs,
    screenshotByteLength,
    screenshotBase64Length,
  } = metadata;
  // The caller's screenWidth/screenHeight are a CLAIM about this frame's geometry, not a
  // measurement: the CtrlProxy clients read them from a screen-dimension cache derived from the
  // last hierarchy they processed. When the device resolution changes, a screenshot can carry
  // fresh pixels while that cache — and therefore the claim — is still the previous geometry.
  //
  // So measure the frame instead of trusting the claim. CtrlProxy never downscales (Android
  // compresses at fixed quality, iOS returns the native-scale PNG), so the header dimensions are
  // the frame's true geometry.
  const measured = readImageHeaderDimensions(
    options.decodedImage ?? Buffer.from(screenshotBase64, "base64"),
  );
  const claimMatchesPixels = pixelsMatchClaimedGeometry(measured, screenWidth, screenHeight);

  return {
    type: "screenshot_update",
    deviceId,
    timestamp: timer.now(),
    screenshotBase64,
    // Publish the measured geometry when we have it, so a client that falls back to these
    // dimensions for coordinate mapping maps through the pixels it is actually rendering.
    ...(measured
      ? { screenWidth: measured.width, screenHeight: measured.height }
      : {
          ...(screenWidth === undefined ? {} : { screenWidth }),
          ...(screenHeight === undefined ? {} : { screenHeight }),
        }),
    // Stamp the identity the caller BOUND at request initiation, and only when the frame's real
    // pixels also match the geometry that binding carried. The binding is what survives
    // same-resolution navigation; the pixel check is the backstop that still catches a geometry
    // change between binding and delivery. An unmeasurable frame is equally unproven. In every
    // other case the field is omitted and the control client fails closed rather than pairing
    // against mapping bounds that may not describe these pixels.
    captureSequence: claimMatchesPixels ? options.captureSequence : undefined,
    ...(options.coordinateSpace ? { coordinateSpace: options.coordinateSpace } : {}),
    ...(options.nativeScale === undefined ? {} : { nativeScale: options.nativeScale }),
    frameContext: options.frameContext,
    rotation: options.rotation,
    screenshotMimeType,
    screenshotFormat,
    screenshotCaptureSource,
    screenshotFallback,
    screenshotFallbackReason,
    screenshotCaptureDurationMs,
    screenshotEncodeDurationMs,
    screenshotByteLength,
    screenshotBase64Length,
  };
}
