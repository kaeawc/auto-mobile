/**
 * Accessibility-service screenshot capture for the observation stream, with the ADB screencap
 * fallback and the supported/unsupported latch, extracted from `AndroidCtrlProxyClient` (#11846).
 * Behaviour is unchanged; the client exposes the live state this module needs through
 * {@link AndroidScreenshotCaptureContext}.
 */
import { screenshotPerformanceMetadataFrom } from "./androidCtrlProxyInboundWire";
import WebSocket from "ws";
import type { AdbExecutor } from "../../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import type { Logger } from "../../../utils/logger";
import type { IdGenerator } from "../../../utils/IdGenerator";
import type { Timer } from "../../../utils/SystemTimer";
import type { RequestManager } from "../../../utils/RequestManager";
import type { TrackedScreenGeometry } from "../TrackedScreenGeometry";
import type { AndroidPhysicalDisplayIdResolver } from "./AndroidPhysicalDisplayId";
import { logger } from "../../../utils/logger";
import { ScreenshotCaptureResult, computeChecksum } from "../ScreenshotBackoffScheduler";
import {
  ANDROID_ADB_SCREENSHOT_METADATA,
  ANDROID_CTRLPROXY_SCREENSHOT_METADATA,
  metadataForScreenshotFormat,
  type ScreenshotFallbackReason,
} from "../ScreenshotMetadata";
import {
  CTRLPROXY_RATE_LIMITED_ERROR,
  CTRLPROXY_SCREENSHOT_TIMEOUT_ERROR,
  fallbackReasonForCtrlProxyFailure,
} from "./screenshotFallbackReason";
import {
  decodePngBase64Output,
  withAndroidScreenshotCaptureLock,
} from "./AndroidPhysicalDisplayId";
import { ctrlProxyRequests, serializeCtrlProxyRequest } from "./ctrlProxyProtocol";
import { errorMessage } from "../../../utils/describeUnknownError";
import { screenshotTempIdToken } from "../../../utils/screenshot/screenshotFormats";
import { shellQuote } from "../../../utils/shellQuote";
import type { ScreenshotResult } from "./types";

export const A11Y_SCREENSHOT_MAX_FAILURES = 3;
export const A11Y_SCREENSHOT_REPROBE_COOLDOWN_MS = 60_000;

/** Client-backed accessors resolve live state on every use, including after awaits. */
export interface AndroidScreenshotCaptureContext {
  readonly adb: AdbExecutor;
  readonly timer: Pick<Timer, "now">;
  readonly deviceId: string;
  readonly closed: boolean;
  readonly logger: Logger;
  readonly idGenerator: IdGenerator;
  readonly physicalDisplayIdResolver: AndroidPhysicalDisplayIdResolver;
  readonly screenGeometry: TrackedScreenGeometry;
  readonly requestManager: RequestManager;
  readonly screenshotObservationStreamSuppressions: Set<string>;
  readonly socket: WebSocket | null;
  /** Advances the shared accessibility screenshot rate-limit floor clock (issue #4927). */
  noteScreenshotCaptureStarted(): void;
}

export class AndroidScreenshotCapture {
  /**
   * null = unknown, true = supported, false = unsupported (fall back to ADB screencap). Only
   * marked unsupported after consecutive failures to avoid disabling on transient timeouts.
   */
  a11yScreenshotSupported: boolean | null = null;
  private a11yScreenshotFailures = 0;
  private a11yScreenshotUnsupportedSince: number | null = null;

  constructor(private readonly context: AndroidScreenshotCaptureContext) {}

  async captureForObservationStream(): Promise<ScreenshotCaptureResult> {
    // Keep unsupported devices on ADB between probes, but periodically recheck in case the
    // CtrlProxy service/APK was updated without replacing this client instance.
    if (this.a11yScreenshotSupported === false && !this.prepareA11yScreenshotReprobe()) {
      return this.captureViaAdb("a11y_screenshot_unsupported");
    }

    if (!this.context.socket || this.context.socket.readyState !== WebSocket.OPEN) {
      return this.captureViaAdb("websocket_unavailable");
    }

    const requestId = this.context.requestManager.generateId("screenshot-backoff");
    const message = serializeCtrlProxyRequest(ctrlProxyRequests.requestScreenshot({ requestId }));
    // Bind the capture identity current at INITIATION and carry it through the await, so a
    // hierarchy forwarded while this frame is in flight cannot relabel it.
    const captureBinding = this.context.screenGeometry.bind() ?? undefined;

    try {
      this.context.screenshotObservationStreamSuppressions.add(requestId);
      const screenshotPromise = this.context.requestManager.register<ScreenshotResult>(
        requestId,
        "screenshot",
        3000,
        (_id, _type, _timeout) => ({ success: false, error: CTRLPROXY_SCREENSHOT_TIMEOUT_ERROR }),
      );

      // Advance the shared rate-limit floor clock at the a11y-request boundary so a direct capture
      // (e.g. the initial subscriber frame) and a scheduler-armed capture cannot both hit the
      // accessibility screenshot API in the same floor window (issue #4927).
      this.context.noteScreenshotCaptureStarted();
      this.context.socket.send(message);

      const result = await screenshotPromise;

      if (!result.success || !result.data) {
        if (result.error === CTRLPROXY_RATE_LIMITED_ERROR) {
          this.a11yScreenshotFailures = 0;
          return this.captureViaAdb(fallbackReasonForCtrlProxyFailure(result.error));
        }

        this.a11yScreenshotFailures++;
        if (
          this.a11yScreenshotSupported === null &&
          this.a11yScreenshotFailures >= A11Y_SCREENSHOT_MAX_FAILURES
        ) {
          logger.info(
            "[CTRL_PROXY] Accessibility service screenshot not supported after " +
              `${this.a11yScreenshotFailures} consecutive failures, falling back to ADB screencap`,
          );
          this.a11yScreenshotSupported = false;
          this.a11yScreenshotUnsupportedSince = this.context.timer.now();
        }
        return this.captureViaAdb(fallbackReasonForCtrlProxyFailure(result.error));
      }

      this.a11yScreenshotFailures = 0;
      this.a11yScreenshotSupported = true;
      const checksum = computeChecksum(result.data);

      return {
        success: true,
        data: result.data,
        checksum,
        captureBinding,
        frameContext: result.frameContext,
        rotation: result.rotation,
        ...metadataForScreenshotFormat(ANDROID_CTRLPROXY_SCREENSHOT_METADATA, result.format),
        ...screenshotPerformanceMetadataFrom(result),
      };
    } catch (error) {
      this.context.requestManager.resolve<ScreenshotResult>(requestId, {
        success: false,
        error: `${error}`,
      });
      return this.captureViaAdb("ctrlproxy_exception");
    } finally {
      this.context.screenshotObservationStreamSuppressions.delete(requestId);
    }
  }

  resetA11yScreenshotSupport(): void {
    this.a11yScreenshotSupported = null;
    this.a11yScreenshotFailures = 0;
    this.a11yScreenshotUnsupportedSince = null;
  }

  private prepareA11yScreenshotReprobe(): boolean {
    const unsupportedSince = this.a11yScreenshotUnsupportedSince;
    if (
      unsupportedSince === null ||
      this.context.timer.now() - unsupportedSince < A11Y_SCREENSHOT_REPROBE_COOLDOWN_MS
    ) {
      return false;
    }

    this.a11yScreenshotSupported = null;
    // One failed post-cooldown probe should relatch immediately and restart the cooldown.
    this.a11yScreenshotFailures = A11Y_SCREENSHOT_MAX_FAILURES - 1;
    this.a11yScreenshotUnsupportedSince = null;
    return true;
  }

  /**
   * Fallback screenshot capture via ADB screencap for devices that don't support
   * accessibility service screenshots (API < 30).
   */
  private async captureViaAdb(
    fallbackReason?: ScreenshotFallbackReason,
  ): Promise<ScreenshotCaptureResult> {
    // Once the client is terminally closed, suppress the signal-less ADB screencap
    // fallback so a capture rejected by close() cannot keep the transport referenced
    // past teardown (#5493). A transient websocket disconnect does not set this flag,
    // so the fallback still fires during reconnect windows.
    if (this.context.closed) {
      return {
        success: false,
        error: "AndroidCtrlProxyClient closed; ADB screencap fallback suppressed",
      };
    }

    // Bind the geometry current when the ADB request begins, before its await can let a newer
    // hierarchy relabel the returned pixels.
    const captureBinding = this.context.screenGeometry.bind() ?? undefined;

    try {
      const tempFile = `/data/local/tmp/am-shot-${screenshotTempIdToken(this.context.idGenerator.next())}.png`;
      const displayId = await this.context.physicalDisplayIdResolver.resolve(
        this.context.adb,
        this.context.deviceId,
      );
      const displayArgument = displayId ? `-d ${displayId} ` : "";
      const quotedTempFile = shellQuote(tempFile);
      const command = `shell "screencap ${displayArgument}-p ${quotedTempFile} && base64 ${quotedTempFile} && rm ${quotedTempFile}"`;
      const maxBuffer = 50 * 1024 * 1024;
      const result = await withAndroidScreenshotCaptureLock(this.context.deviceId, () =>
        this.context.adb.executeCommand(command, { maxBuffer }),
      );

      if (!result.stdout || result.stdout.trim().length === 0) {
        return { success: false, error: "No data from ADB screencap" };
      }

      const data = decodePngBase64Output(result.stdout).toString("base64");
      const checksum = computeChecksum(data);

      return {
        success: true,
        data,
        checksum,
        captureBinding,
        ...ANDROID_ADB_SCREENSHOT_METADATA,
        screenshotFallbackReason: fallbackReason,
      };
    } catch (error) {
      const log = this.context.logger;
      const message = errorMessage(error);
      log.warn(`[CTRL_PROXY] ADB screencap failed: ${message}`, error);
      return { success: false, error: `ADB screencap failed: ${message}` };
    }
  }
}
