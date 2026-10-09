import { errorMessage } from "../../utils/describeUnknownError";
import { DefaultFileSystem, type FileSystem } from "../../utils/filesystem/DefaultFileSystem";
import path from "path";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { Window } from "./Window";
import { logger } from "../../utils/logger";
import { ActionableError } from "../../models/ActionableError";
import { ScreenshotResult } from "../../models/ScreenshotResult";
import { Image } from "../../utils/image-utils";
import { detectImageMimeType } from "../../utils/screenshot/imageHeaderDimensions";
import {
  validateScreenshotOptions,
  type ScreenshotEncodingOptions,
} from "./screenshot/screenshotOptions";
import { BootedDevice } from "../../models";
import {
  ScreenshotJobHandle,
  ScreenshotJobOptions,
  ScreenshotJobTracker,
} from "../../utils/ScreenshotJobTracker";
import { OPERATION_CANCELLED_MESSAGE } from "../../utils/constants";
import { awaitWhileRequestIsLive, throwIfAborted } from "../../utils/toolUtils";
import { ensureSecureTempDirSync, TEMP_SUBDIRS } from "../../utils/tempDir";
import type { ScreenshotService } from "./interfaces/ScreenshotService";
import { writeRetainedScreenshot } from "./ScreenshotRetention";
import {
  screenshotPathProtection,
  type ScreenshotPathProtection,
} from "./ScreenshotPathProtection";
import { IOSCtrlProxyClient } from "./ios";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { AndroidCtrlProxyClient } from "./android";
import type { CtrlProxyScreenshotResult } from "./ios/types";
import { getDeviceDataStreamServer } from "../../daemon/deviceDataStreamSocketServer";
import { DaemonState } from "../../daemon/daemonState";
import { Timer, defaultTimer } from "../../utils/SystemTimer";
import { defaultIdGenerator, IdGenerator } from "../../utils/IdGenerator";
import {
  ANDROID_ADB_SCREENSHOT_METADATA,
  ANDROID_CTRLPROXY_SCREENSHOT_METADATA,
  IOS_CTRLPROXY_SCREENSHOT_METADATA,
  metadataForScreenshotFormat,
} from "./ScreenshotMetadata";
import {
  screenshotExtensionForFormat,
  screenshotFileName,
  screenshotTempIdToken,
} from "../../utils/screenshot/screenshotFormats";
import {
  defaultScreenshotFileWriter,
  type ScreenshotFileWriter,
} from "./screenshot/ScreenshotFileWriter";
import { shellQuote } from "../../utils/shellQuote";
import {
  AndroidPhysicalDisplayIdResolver,
  type PhysicalDisplayIdResolver,
  assertValidPng,
  decodePngBase64Output,
  withAndroidScreenshotCaptureLock,
} from "./android/AndroidPhysicalDisplayId";
import { readImageHeaderDimensions } from "../../utils/screenshot/imageHeaderDimensions";
import { displayTransitions } from "./DisplayTransition";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import {
  defaultIosCaptureOverlayHider,
  type IosCaptureOverlayHiderResolver,
} from "../overlay/ios/iosCaptureOverlayHider";
import { captureHideDeadlineMs } from "../overlay/ios/iosOverlayTransport";
import { raceWithDeadline } from "../../utils/raceWithDeadline";

const SCREENSHOT_CLEANUP_TIMEOUT_MS = 1500;
/** How long the host waits for the CtrlProxy iOS screenshot; the overlay hide deadline derives from it. */
const IOS_SCREENSHOT_TIMEOUT_MS = 10000;

export function replaceScreenshotExtension(filePath: string, extension: string): string {
  const oldExtension = path.extname(filePath);
  return `${filePath.slice(0, filePath.length - oldExtension.length)}.${extension}`;
}

export interface ScreenshotOptions {
  format?: "jpeg" | "png" | "webp";
  quality?: number;
  lossless?: boolean;
  /** Android logical display selected by observe. */
  displayId?: number;
  /**
   * Capture with the device's overlay hidden (#9305). Set only for a device whose agent advertises
   * `screenshot_hide_overlay_v1`: Android CtrlProxy, or the connected iOS overlay agent. There is
   * no fallback: a capture that cannot confirm the overlay was hidden fails rather than return an
   * image that shows it.
   */
  hideOverlays?: boolean;
}

async function encodeScreenshot(
  source: Buffer,
  options: ScreenshotEncodingOptions,
): Promise<Buffer> {
  const format = options.format ?? "png";
  if (
    detectImageMimeType(source) === `image/${format}` &&
    options.quality === undefined &&
    options.lossless !== true
  ) {
    return source;
  }
  if (!detectImageMimeType(source)) {
    throw new Error("Screenshot has an unsupported image format");
  }
  const image = Image.fromBuffer(source);
  let encoded: Buffer;
  switch (format) {
    case "png":
      encoded = await image.png().toBuffer();
      break;
    case "jpeg":
      encoded = await image.jpeg({ quality: options.quality }).toBuffer();
      break;
    case "webp":
      encoded = await image
        .webp(options.lossless ? { lossless: true } : { quality: options.quality ?? 75 })
        .toBuffer();
      break;
  }
  if (detectImageMimeType(encoded) !== `image/${format}`) {
    throw new Error(`Screenshot encoder did not produce ${format} bytes`);
  }
  return encoded;
}

function encodingOptions(options: ScreenshotOptions): ScreenshotEncodingOptions {
  return validateScreenshotOptions({
    ...(options.format === undefined ? {} : { format: options.format }),
    ...(options.quality === undefined ? {} : { quality: options.quality }),
    ...(options.lossless === undefined ? {} : { lossless: options.lossless }),
  });
}

function ctrlProxyScreenshotFormat(
  result: CtrlProxyScreenshotResult,
  imageBuffer: Buffer,
  useLegacyFormat: boolean,
): "png" | "jpeg" | "webp" {
  if (useLegacyFormat) {
    return result.format?.toLowerCase() === "png" ? "png" : "jpeg";
  }
  const mime = detectImageMimeType(imageBuffer);
  if (!mime) {
    throw new Error("Android CtrlProxy returned an unsupported screenshot format");
  }
  return mime.slice(6) as "png" | "jpeg" | "webp";
}

function resolveIosOverlayHider(
  hider: IosCaptureOverlayHiderResolver | undefined,
): IosCaptureOverlayHiderResolver {
  return hider ?? defaultIosCaptureOverlayHider;
}

export class TakeScreenshot implements ScreenshotService {
  /** Device reads may write one capture but must not evict another session's cache. */
  static forObservationRead(device: BootedDevice): TakeScreenshot {
    return new TakeScreenshot(
      device,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      false,
    );
  }

  /** Read a screenshot without changing an owner's client or starting a service. */
  async executeObservationRead(
    options: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<ScreenshotResult> {
    // Never register with the owner's ScreenshotJobTracker or abort its capture.
    // Bound lock waits, display discovery, and capture with this read's own signal.
    const deadline = new AbortController();
    const callerSignal = combineWithAmbientAbort(signal);
    const captureSignal = AbortSignal.any([
      deadline.signal,
      ...(callerSignal ? [callerSignal] : []),
    ]);
    const startedAt = this.timer.now();
    const finalPath = this.generateScreenshotPath(startedAt, options);
    try {
      return await raceWithDeadline(
        async () => {
          if (this.device.platform !== "ios") {
            return this.captureScreenshotBase64(finalPath, options, captureSignal, true);
          }
          const capture = await this.captureIosObserverScreenshot(captureSignal);
          return this.writeiOSScreenshot(
            finalPath,
            capture,
            startedAt,
            options,
            captureSignal,
            false,
          );
        },
        {
          timer: this.timer,
          timeoutMs: 10_000,
          signal: captureSignal,
          label: "Observer screenshot capture",
          onTimeout: () => deadline.abort(),
        },
      );
    } catch (error) {
      logger.warn(`[SCREENSHOT] Observer capture failed: ${errorMessage(error)}`, error);
      return {
        success: false,
        error: callerSignal?.aborted ? OPERATION_CANCELLED_MESSAGE : errorMessage(error),
      };
    } finally {
      // Fence a late lock waiter or capture after timeout/cancellation.
      deadline.abort();
    }
  }

  private async captureIosObserverScreenshot(
    signal?: AbortSignal,
  ): Promise<CtrlProxyScreenshotResult> {
    const client = IOSCtrlProxyClient.getExistingInstance(this.device.deviceId);
    if (client?.isConnected()) {
      return client.requestScreenshotForObserver(10000, signal);
    }
    if (resolveIosDeviceKind({ deviceId: this.device.deviceId }) === "simulator") {
      return this.captureSimulatorObserverScreenshot(signal);
    }
    const daemon = DaemonState.getInstance();
    if (
      daemon.isInitialized() &&
      daemon.getDevicePool().getDevice(this.device.deviceId)?.sessionId
    ) {
      return { success: false, error: "Owned iOS device has no connected screenshot service" };
    }
    const transient = IOSCtrlProxyClient.createForObservationRead(this.device);
    try {
      if (!(await transient.connectForObservationRead())) {
        return {
          success: false,
          error:
            "No screenshot could be captured: this unowned physical iOS device has no reachable runner. Physical iOS has no host-side screenshot capture path without the runner.",
        };
      }
      return await transient.requestScreenshotForObserver(10000, signal);
    } finally {
      await transient.close();
    }
  }

  private async captureSimulatorObserverScreenshot(
    signal?: AbortSignal,
  ): Promise<CtrlProxyScreenshotResult> {
    const observedPanel = displayTransitions.currentObservedPanel(this.device.deviceId)?.key;
    const png = await new SimCtlClient(this.device).screenshot(
      this.device.deviceId,
      observedPanel ?? this.device.displays?.panels[0]?.key ?? "main",
      signal,
    );
    return { success: true, data: png.toString("base64"), format: "png" };
  }
  private readonly device: BootedDevice;
  private adb: AdbExecutor;
  private adbFactory: AdbClientFactory;
  private window: Window;
  private timer: Timer;
  private idGenerator: IdGenerator;
  private fileWriter: ScreenshotFileWriter;
  private fileSystem: FileSystem;
  private cacheDirResolver: () => string;
  private readonly pathProtection: ScreenshotPathProtection;
  private readonly iosOverlayHider: IosCaptureOverlayHiderResolver;
  private readonly physicalDisplayIdResolver: PhysicalDisplayIdResolver;
  private static cacheDir: string | null = null;

  /**
   * Get the cache directory, creating it with secure permissions if needed.
   * Uses lazy initialization to ensure the directory is created securely.
   */
  private static getCacheDir(): string {
    if (!TakeScreenshot.cacheDir) {
      TakeScreenshot.cacheDir = ensureSecureTempDirSync(TEMP_SUBDIRS.SCREENSHOTS);
    }
    return TakeScreenshot.cacheDir;
  }

  /**
   * Create a TakeScreenshot instance
   * @param device - Device to run ADB commands against
   * @param adbFactory - Factory for creating AdbClient instances
   */
  constructor(
    device: BootedDevice,
    adbFactory: AdbClientFactory = defaultAdbClientFactory,
    timer: Timer = defaultTimer,
    idGenerator: IdGenerator = defaultIdGenerator,
    fileWriter: ScreenshotFileWriter = defaultScreenshotFileWriter,
    fileSystem: FileSystem = new DefaultFileSystem(),
    cacheDirResolver: () => string = () => TakeScreenshot.getCacheDir(),
    physicalDisplayIdResolver: PhysicalDisplayIdResolver = new AndroidPhysicalDisplayIdResolver({
      timer,
    }),
    cleanupOnCreate = true,
    options: {
      pathProtection?: ScreenshotPathProtection;
      iosOverlayHider?: IosCaptureOverlayHiderResolver;
    } = {},
  ) {
    this.pathProtection = options.pathProtection ?? screenshotPathProtection;
    this.iosOverlayHider = resolveIosOverlayHider(options.iosOverlayHider);
    this.device = device;
    this.adbFactory = adbFactory;
    this.adb = adbFactory.create(device);
    this.window = new Window(device, this.adbFactory);
    this.timer = timer;
    this.idGenerator = idGenerator;
    this.fileWriter = fileWriter;
    this.fileSystem = fileSystem;
    this.cacheDirResolver = cacheDirResolver;
    this.physicalDisplayIdResolver = physicalDisplayIdResolver;

    // Manage cache size (getCacheDir ensures directory exists with secure permissions)
    this.pathProtection.start(this.cacheDirResolver(), { fileSystem: this.fileSystem });
    if (cleanupOnCreate) {
      this.cleanupCacheOnce();
    }
  }

  private cleanupCacheOnce(): void {
    void this.pathProtection.sweepOnce(this.cacheDirResolver(), this.fileSystem);
  }

  private async writeScreenshot(filePath: string, bytes: Buffer): Promise<void> {
    await writeRetainedScreenshot(filePath, bytes, {
      pathProtection: this.pathProtection,
      writer: this.fileWriter,
      fileSystem: this.fileSystem,
    });
  }

  private async removeUnpublishedScreenshot(filePath: string): Promise<void> {
    await this.pathProtection.removeIfUnprotected(filePath, async () => {
      await this.fileWriter.remove(filePath);
      return true;
    });
  }

  /**
   * Generate screenshot file path
   * @param timestamp - Timestamp for readable filename ordering
   * @param options - Screenshot options
   * @returns Full file path for screenshot
   */
  generateScreenshotPath(timestamp: number, options: ScreenshotOptions): string {
    const fileExtension = screenshotExtensionForFormat(options.format ?? "png");
    return path.join(
      this.cacheDirResolver(),
      // The device id is part of the name so a disk scan of the shared cache
      // dir can tell whose capture a file is (#6599).
      screenshotFileName(timestamp, this.device.deviceId, this.idGenerator.next(), fileExtension),
    );
  }

  /**
   * Get activity hash for screenshot naming
   * @param activityHash - Optional provided hash
   * @returns Promise with activity hash
   */
  public async getActivityHash(activityHash: string | null): Promise<string> {
    return !activityHash ? await this.window.getActiveHash() : activityHash;
  }

  /**
   * Take a screenshot of the device
   * @param options - Optional screenshot format options
   * @returns Promise with screenshot result including success status and path if successful
   */
  async execute(
    options: ScreenshotOptions = { format: "png" },
    signal?: AbortSignal,
  ): Promise<ScreenshotResult> {
    const startTime = this.timer.now();
    logger.info(
      `[SCREENSHOT] *** Starting screenshot capture with startTime: ${startTime}, format: ${options.format} ***`,
    );

    try {
      const encoding = encodingOptions(options);
      options = { ...options, ...encoding };
      if (signal?.aborted) {
        return { success: false, error: OPERATION_CANCELLED_MESSAGE };
      }
      // Generate unique filename with startTime
      const finalPath = this.generateScreenshotPath(startTime, options);

      // Capture screenshot with fallback
      const captureResult = await this.captureScreenshot(finalPath, options, signal);
      const totalDuration = this.timer.now() - startTime;

      logger.info(
        `[SCREENSHOT] *** Screenshot capture completed: success=${captureResult.success}, total execute time: ${totalDuration}ms ***`,
      );
      return captureResult;
    } catch (err) {
      const totalDuration = this.timer.now() - startTime;
      const errorMsg = errorMessage(err);
      logger.warn(`[SCREENSHOT] Execute failed after ${totalDuration}ms: ${errorMsg}`, err);
      return {
        success: false,
        error: `Failed to take screenshot: ${errorMsg}`,
      };
    }
  }

  /**
   * Start a tracked screenshot capture that can be awaited or cancelled later.
   */
  startTrackedCapture(
    options: ScreenshotOptions = { format: "png" },
    trackerOptions: ScreenshotJobOptions = {},
  ): ScreenshotJobHandle {
    return ScreenshotJobTracker.startJob(
      this.device.deviceId,
      (signal) => this.execute(options, signal),
      trackerOptions,
    );
  }

  /**
   * Capture screenshot using screencap method with fallback
   * @param finalPath - Path to save the screenshot
   * @param options - Screenshot format options
   * @returns ScreenshotResult with path to the saved screenshot or error
   */
  private async captureScreenshot(
    finalPath: string,
    options: ScreenshotOptions = { format: "png" },
    signal?: AbortSignal,
  ): Promise<ScreenshotResult> {
    logger.info(`[SCREENSHOT] Starting screenshot capture with format: ${options.format}`);

    switch (this.device.platform) {
      case "android":
        return await this.captureAndroidScreenshot(finalPath, options, signal);
      case "ios":
        return await this.captureiOSScreenshot(finalPath, options, signal);
      default:
        throw new Error(`Unsupported platform: ${this.device.platform}`);
    }
  }

  /**
   * Capture screenshot using screencap method with fallback
   * @param finalPath - Path to save the screenshot
   * @param options - Screenshot format options
   * @returns ScreenshotResult with path to the saved screenshot or error
   */
  private async captureAndroidScreenshot(
    finalPath: string,
    options: ScreenshotOptions = { format: "png" },
    signal?: AbortSignal,
  ): Promise<ScreenshotResult> {
    logger.info(`[SCREENSHOT] Starting screenshot capture with format: ${options.format}`);

    if (options.hideOverlays === true) {
      return this.captureScreenshotWithOverlayHidden(finalPath, options, signal);
    }

    if (
      options.format === undefined ||
      (options.format === "jpeg" && options.quality === undefined)
    ) {
      try {
        return await this.captureScreenshotViaCtrlProxy(
          finalPath,
          signal,
          options.displayId,
          options.format === undefined,
        );
      } catch (error) {
        if (options.displayId !== undefined) {
          throw error;
        }
        logger.info(`[SCREENSHOT] CtrlProxy capture failed, falling back to ADB: ${error}`);
        if (options.format === undefined) {
          finalPath = replaceScreenshotExtension(finalPath, "png");
          options = { ...options, format: "png" };
        }
      }
    }

    return this.captureAndroidScreenshotViaAdb(finalPath, options, signal);
  }

  private async captureAndroidScreenshotViaAdb(
    finalPath: string,
    options: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<ScreenshotResult> {
    // Try base64 approach first (faster for smaller screenshots)
    try {
      return await this.captureScreenshotBase64(finalPath, options, signal);
    } catch (err) {
      const errorMsg = errorMessage(err);
      if (
        errorMsg.includes("maxBuffer") ||
        errorMsg.includes("stdout") ||
        errorMsg.includes("buffer")
      ) {
        logger.info(
          `[SCREENSHOT] Base64 approach failed (${errorMsg}), falling back to file pull approach`,
        );
        return await this.captureScreenshotFilePull(finalPath, options, signal);
      } else {
        // For other errors, don't fallback
        throw err;
      }
    }
  }

  private async screencapDisplayArgument(
    options: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<string> {
    throwIfAborted(signal);
    if (options.displayId !== undefined) {
      if (!Number.isSafeInteger(options.displayId) || options.displayId < 0) {
        throw new Error(`Invalid Android display id: ${options.displayId}`);
      }
      // screencap -d takes the SurfaceFlinger physical id; the logical id is rejected.
      const physicalId = await this.physicalDisplayIdResolver.resolveLogical(
        this.adb,
        this.device.deviceId,
        options.displayId,
        signal,
      );
      if (physicalId !== null) {
        return `-d ${physicalId} `;
      }
      if (options.displayId === 0) {
        // Plain screencap captures the default display, which is logical display 0.
        logger.warn("[SCREENSHOT] No physical id for default display 0; capturing without -d");
        return "";
      }
      throw new ActionableError(
        `Cannot screenshot Android display ${options.displayId}: no physical display id could be resolved from "cmd display get-displays". The display may have been disconnected; re-run observe to refresh the display list.`,
      );
    }
    const displayId = await this.physicalDisplayIdResolver.resolve(
      this.adb,
      this.device.deviceId,
      signal,
    );
    return displayId ? `-d ${displayId} ` : "";
  }

  /**
   * Run the CtrlProxy screenshot request under the caller's cancellation.
   *
   * @returns the capture, or null when the caller cancelled instead.
   */
  private async requestCtrlProxyCapture(
    signal?: AbortSignal,
    displayId?: number,
    hideOverlays = false,
  ): Promise<CtrlProxyScreenshotResult | null> {
    const client = AndroidCtrlProxyClient.getInstance(this.device, this.adbFactory);
    try {
      // The client's own 10s timeout is unaware of the signal, so race it
      // against the abort the way the iOS path does - otherwise a cancelled
      // capture still blocks the caller for the full request timeout. The signal
      // also goes INTO the client: winning the outer race only unblocks this
      // caller, while the request itself would still be dispatched once the
      // (re)connection completes, burning the shared screenshot rate limit and
      // pushing a late observation-stream frame (#6605).
      const result = await awaitWhileRequestIsLive(
        client.requestScreenshot(10000, undefined, false, signal, displayId, hideOverlays),
        signal,
      );
      return signal?.aborted ? null : result;
    } catch (error) {
      // An abort is the caller's own cancellation, not a capture failure: report
      // it as cancelled instead of falling back to the slower ADB path.
      if (signal?.aborted) {
        logger.debug(`[SCREENSHOT] Android CtrlProxy capture cancelled: ${errorMessage(error)}`);
        return null;
      }
      throw error;
    }
  }

  private async captureScreenshotViaCtrlProxy(
    finalPath: string,
    signal?: AbortSignal,
    displayId?: number,
    useLegacyFormat: boolean = false,
  ): Promise<ScreenshotResult> {
    const result = await this.requestCtrlProxyCapture(signal, displayId);
    if (!result) {
      return { success: false, error: OPERATION_CANCELLED_MESSAGE };
    }
    if (!result.success || !result.data) {
      throw new Error(result.error || "No screenshot data returned from Android CtrlProxy");
    }

    const imageBuffer = Buffer.from(result.data, "base64");
    const format = ctrlProxyScreenshotFormat(result, imageBuffer, useLegacyFormat);
    const screenshotPath = replaceScreenshotExtension(
      finalPath,
      screenshotExtensionForFormat(format),
    );
    await this.writeScreenshot(screenshotPath, imageBuffer);
    if (signal?.aborted) {
      // Cancellation can land while the write is in flight: the request is over,
      // so drop the frame instead of leaving it for the latest-screenshot disk
      // fallback to serve as the device's current screen (#6605).
      await this.removeUnpublishedScreenshot(screenshotPath);
      return { success: false, error: OPERATION_CANCELLED_MESSAGE };
    }
    return {
      success: true,
      path: screenshotPath,
      screenshotImageSize: readImageHeaderDimensions(imageBuffer) ?? undefined,
      ...metadataForScreenshotFormat(ANDROID_CTRLPROXY_SCREENSHOT_METADATA, format),
    };
  }

  /**
   * Hide-capture-restore happens on the device in the one CtrlProxy request (#9305). The image is
   * encoded to the requested format; without a requested format the device's own bytes are kept.
   */
  private async captureScreenshotWithOverlayHidden(
    finalPath: string,
    options: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<ScreenshotResult> {
    const result = await this.requestCtrlProxyCapture(signal, options.displayId, true);
    if (!result) {
      return { success: false, error: OPERATION_CANCELLED_MESSAGE };
    }
    if (!result.success || !result.data) {
      return {
        success: false,
        error: `Screenshot with the overlay hidden failed: ${result.error ?? "no image data returned from Android CtrlProxy"}`,
      };
    }
    if (result.overlaysHidden !== true) {
      return {
        success: false,
        error:
          "Android CtrlProxy could not confirm its overlay was hidden for the capture; retry the observe",
      };
    }
    const deviceBytes = Buffer.from(result.data, "base64");
    const format = options.format ?? ctrlProxyScreenshotFormat(result, deviceBytes, true);
    const imageBuffer =
      options.format === undefined
        ? deviceBytes
        : await encodeScreenshot(deviceBytes, encodingOptions(options));
    const screenshotPath = replaceScreenshotExtension(
      finalPath,
      screenshotExtensionForFormat(format),
    );
    await this.writeScreenshot(screenshotPath, imageBuffer);
    if (signal?.aborted) {
      await this.removeUnpublishedScreenshot(screenshotPath);
      return { success: false, error: OPERATION_CANCELLED_MESSAGE };
    }
    return {
      success: true,
      path: screenshotPath,
      screenshotImageSize: readImageHeaderDimensions(imageBuffer) ?? undefined,
      overlaysHidden: true,
      ...metadataForScreenshotFormat(ANDROID_CTRLPROXY_SCREENSHOT_METADATA, format),
    };
  }

  /**
   * Capture screenshot using CtrlProxy iOS
   * @param finalPath - Path to save the screenshot
   * @returns ScreenshotResult with path to the saved screenshot or error
   */
  private async captureiOSScreenshot(
    finalPath: string,
    options: ScreenshotOptions,
    signal?: AbortSignal,
  ): Promise<ScreenshotResult> {
    const startTime = this.timer.now();

    try {
      const client = IOSCtrlProxyClient.getInstance(this.device);

      // Ensure connected before requesting screenshot
      if (!(await awaitWhileRequestIsLive(client.ensureConnected(), signal))) {
        return {
          success: false,
          error: "Failed to connect to CtrlProxy iOS",
        };
      }
      throwIfAborted(signal);

      // Request screenshot from CtrlProxy iOS
      const request = (): Promise<CtrlProxyScreenshotResult> =>
        awaitWhileRequestIsLive(
          client.requestScreenshot(IOS_SCREENSHOT_TIMEOUT_MS, undefined, signal),
          signal,
        );
      const result = await this.requestiOSScreenshot(request, options);
      const written = await this.writeiOSScreenshot(finalPath, result, startTime, options, signal);
      return options.hideOverlays === true && written.success
        ? { ...written, overlaysHidden: true }
        : written;
    } catch (error) {
      const errorMsg = errorMessage(error);
      logger.warn(`[SCREENSHOT] iOS screenshot capture failed: ${errorMsg}`, error);
      return {
        success: false,
        error: errorMsg,
      };
    }
  }

  private requestiOSScreenshot(
    request: () => Promise<CtrlProxyScreenshotResult>,
    options: ScreenshotOptions,
  ): Promise<CtrlProxyScreenshotResult> {
    return options.hideOverlays === true
      ? this.requestiOSScreenshotWithOverlayHidden(request)
      : request();
  }

  /**
   * Hide-capture-restore around the simulator screenshot (#9305). The agent answers the hide before the
   * capture runs; a hide it never confirmed fails the capture rather than return an image that
   * shows the overlay.
   */
  private async requestiOSScreenshotWithOverlayHidden(
    request: () => Promise<CtrlProxyScreenshotResult>,
  ): Promise<CtrlProxyScreenshotResult> {
    const hider = this.iosOverlayHider(this.device.deviceId);
    if (hider === undefined) {
      return {
        success: false,
        error:
          "The iOS overlay agent is no longer connected, so the overlay cannot be hidden for the capture; retry the observe",
      };
    }
    const { value, hideUnconfirmed } = await hider.captureWithOverlayHidden(
      request,
      captureHideDeadlineMs(IOS_SCREENSHOT_TIMEOUT_MS),
    );
    if (hideUnconfirmed === true && value.success) {
      return {
        success: false,
        error:
          "The iOS overlay agent could not confirm its overlay was hidden for the capture; retry the observe",
      };
    }
    return value;
  }

  private async writeiOSScreenshot(
    finalPath: string,
    result: CtrlProxyScreenshotResult,
    startTime: number,
    options: ScreenshotOptions,
    signal?: AbortSignal,
    pushToStream = true,
  ): Promise<ScreenshotResult> {
    if (signal?.aborted) {
      return { success: false, error: OPERATION_CANCELLED_MESSAGE };
    }

    if (!result.success || !result.data) {
      return {
        success: false,
        error: result.error || "No screenshot data returned",
      };
    }

    // Decode base64 and save to file securely
    const imageBuffer = Buffer.from(result.data, "base64");
    const encoding = encodingOptions(options);
    const format = encoding.format ?? "png";
    // The historical iOS PNG path persisted CtrlProxy's bytes without encoding.
    const encoded = format === "png" ? imageBuffer : await encodeScreenshot(imageBuffer, encoding);
    await this.writeScreenshot(finalPath, encoded);
    if (signal?.aborted) {
      // A cancellation can land while the write is in flight. Remove the frame
      // so findLatestScreenshotPath(deviceId) cannot surface it as current (#6605).
      await this.removeUnpublishedScreenshot(finalPath);
      return { success: false, error: OPERATION_CANCELLED_MESSAGE };
    }

    const durationMs = this.timer.now() - startTime;
    logger.info(`[SCREENSHOT] iOS screenshot captured in ${durationMs}ms, saved to ${finalPath}`);

    const screenshotImageSize = readImageHeaderDimensions(encoded) ?? undefined;
    this.pushiOSScreenshotIfAllowed(
      result,
      imageBuffer,
      encoded,
      format,
      pushToStream,
      screenshotImageSize,
    );

    return {
      success: true,
      path: finalPath,
      screenshotImageSize,
      ...metadataForScreenshotFormat(IOS_CTRLPROXY_SCREENSHOT_METADATA, format),
    };
  }

  private pushiOSScreenshotIfAllowed(
    result: CtrlProxyScreenshotResult,
    original: Buffer,
    encoded: Buffer,
    format: "png" | "jpeg" | "webp",
    allowed: boolean,
    dimensions: { width: number; height: number } | undefined,
  ): void {
    if (allowed && result.data) {
      this.pushScreenshotToStream(
        encoded === original ? result.data : encoded.toString("base64"),
        encoded,
        format,
        dimensions,
      );
    }
  }

  /**
   * Push screenshot to the device data stream for IDE plugins.
   */
  private pushScreenshotToStream(
    base64Data: string,
    imageBuffer: Buffer,
    format: "png" | "jpeg" | "webp",
    dimensions: { width: number; height: number } | undefined,
  ): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    if (!dimensions) {
      logger.debug("[SCREENSHOT] Could not read screenshot dimensions from image header");
    }

    try {
      server.pushScreenshotUpdate(
        this.device.deviceId,
        base64Data,
        dimensions?.width,
        dimensions?.height,
        metadataForScreenshotFormat(
          this.device.platform === "ios"
            ? IOS_CTRLPROXY_SCREENSHOT_METADATA
            : ANDROID_ADB_SCREENSHOT_METADATA,
          format,
        ),
        { decodedImage: imageBuffer },
      );
    } catch (error) {
      // The observation stream is an optional side channel; screenshot capture already succeeded.
      logger.debug(`[SCREENSHOT] Failed to push screenshot to observation stream: ${error}`);
    }
  }

  /**
   * Capture screenshot using base64 encoding (faster but may hit buffer limits)
   * @param finalPath - Path to save the screenshot
   * @param options - Screenshot format options
   * @returns ScreenshotResult with path to the saved screenshot or error
   */
  private async captureScreenshotBase64(
    finalPath: string,
    options: ScreenshotOptions = { format: "png" },
    signal?: AbortSignal,
    readOnly = false,
  ): Promise<ScreenshotResult> {
    const startTime = this.timer.now();
    logger.info(`[SCREENSHOT] Trying base64 approach`);

    const cmdStartTime = this.timer.now();
    const tempFile = `/data/local/tmp/am-shot-${screenshotTempIdToken(this.idGenerator.next())}.png`;

    // Single command: screencap -> base64 encode -> remove temp file
    const displayArgument = await this.screencapDisplayArgument(options, signal);
    // Device reads stream the pixels without creating or removing guest files.
    const command = readOnly
      ? `shell "screencap ${displayArgument}-p | base64"`
      : `shell "screencap ${displayArgument}-p ${tempFile} && base64 ${tempFile} && rm ${tempFile}"`;
    // Use larger maxBuffer (50MB) to handle high-resolution screenshots
    const maxBuffer = 50 * 1024 * 1024; // 50MB
    let captureDispatched = false;
    let captureCompleted = false;
    const result = await withAndroidScreenshotCaptureLock(this.device.deviceId, async () => {
      try {
        throwIfAborted(signal);
        captureDispatched = true;
        const captured = await this.adb.executeCommand(
          command,
          undefined,
          maxBuffer,
          undefined,
          signal,
        );
        captureCompleted = true;
        return captured;
      } finally {
        // Successful captures already remove the file in the unchanged chained command.
        if (captureDispatched && !readOnly && (!captureCompleted || signal?.aborted)) {
          this.removeDeviceTempScreenshot(tempFile, "base64");
        }
      }
    });
    const cmdDuration = this.timer.now() - cmdStartTime;
    logger.info(`[SCREENSHOT] Combined ADB command took ${cmdDuration}ms`);

    if (!result.stdout || result.stdout.trim().length === 0) {
      throw new Error("No base64 data received from screencap command");
    }

    // Decode base64 data to buffer
    const decodeStartTime = this.timer.now();
    const imageBuffer = decodePngBase64Output(result.stdout);
    assertValidPng(imageBuffer);
    const decodeDuration = this.timer.now() - decodeStartTime;
    logger.info(
      `[SCREENSHOT] Base64 decode took ${decodeDuration}ms, buffer size: ${imageBuffer.length} bytes`,
    );

    const encoded = await encodeScreenshot(imageBuffer, encodingOptions(options));
    await this.writeScreenshot(finalPath, encoded);
    if (signal?.aborted) {
      await this.removeUnpublishedScreenshot(finalPath);
      return { success: false, error: OPERATION_CANCELLED_MESSAGE };
    }

    const totalDuration = this.timer.now() - startTime;
    logger.info(`[SCREENSHOT] Base64 screenshot capture completed in ${totalDuration}ms`);

    return {
      success: true,
      path: finalPath,
      screenshotImageSize: readImageHeaderDimensions(encoded) ?? undefined,
      ...metadataForScreenshotFormat(ANDROID_ADB_SCREENSHOT_METADATA, options.format),
    };
  }

  private removeDeviceTempScreenshot(path: string, captureMethod: "base64" | "file-pull"): void {
    const cleanup = this.adb
      .execute(["shell", "rm", "-f", path], {
        timeoutMs: SCREENSHOT_CLEANUP_TIMEOUT_MS,
        // Override ADB's ambient request signal so cancellation still permits bounded cleanup.
        signal: new AbortController().signal,
        noRetry: true,
      })
      .catch((error: unknown) => {
        // Best-effort removal is idempotent and must not replace the capture error or cancellation.
        logger.warn(`[SCREENSHOT] Could not remove temporary ${captureMethod} screenshot`, error);
      });
    // Failed/cancelled captures must settle immediately, even if the cleanup executor stalls.
    void cleanup;
  }

  /**
   * Capture screenshot using file pull approach (more reliable for large screenshots)
   * @param finalPath - Path to save the screenshot
   * @param options - Screenshot format options
   * @returns ScreenshotResult with path to the saved screenshot or error
   */
  private async captureScreenshotFilePull(
    finalPath: string,
    options: ScreenshotOptions = { format: "png" },
    signal?: AbortSignal,
  ): Promise<ScreenshotResult> {
    const startTime = this.timer.now();
    logger.info(`[SCREENSHOT] Using file pull approach`);
    const tempFile = `/sdcard/screenshot_${this.sanitizeDeviceTempId(this.idGenerator.next())}.png`;
    const tempLocalFile = `${finalPath}.temp`;
    let result: ScreenshotResult;
    let captureDispatched = false;

    try {
      // Use file pull approach instead of base64 to avoid stdout buffer issues
      const cmdStartTime = this.timer.now();

      // Step 1: Take screenshot on device
      const displayArgument = await this.screencapDisplayArgument(options, signal);
      throwIfAborted(signal);
      captureDispatched = true;
      const screencapResult = await this.adb.executeCommand(
        `shell "screencap ${displayArgument}-p ${shellQuote(tempFile)} ; echo AM_SCREENCAP_RC:$?"`,
        undefined,
        undefined,
        undefined,
        signal,
      );
      if (this.hasFailedScreencap(screencapResult.stdout, screencapResult.stderr)) {
        throw new Error(`Screencap failed: ${screencapResult.stderr}`);
      }

      // Step 2: Pull file from device to local filesystem
      const pullResult = await this.adb.execute(["pull", tempFile, tempLocalFile], { signal });
      if (this.hasCommandError(pullResult.stderr)) {
        throw new Error(`Failed to pull screenshot: ${pullResult.stderr}`);
      }

      if (signal?.aborted) {
        await this.removeLocalTempScreenshot(tempLocalFile);
        return { success: false, error: OPERATION_CANCELLED_MESSAGE };
      }

      const cmdDuration = this.timer.now() - cmdStartTime;
      logger.info(`[SCREENSHOT] Screenshot capture and pull took ${cmdDuration}ms`);

      // Step 4: Read the pulled file into buffer
      const readStartTime = this.timer.now();
      const imageBuffer = await this.fileSystem.readFileBuffer(tempLocalFile);
      assertValidPng(imageBuffer);
      const readDuration = this.timer.now() - readStartTime;
      logger.info(
        `[SCREENSHOT] File read took ${readDuration}ms, buffer size: ${imageBuffer.length} bytes`,
      );

      const encoded =
        options.format === undefined || options.format === "png"
          ? imageBuffer
          : await encodeScreenshot(imageBuffer, encodingOptions(options));
      // Bytes are already in memory. Remove the unpublished pull temporary before
      // admission so it is not counted twice; persist through the secure 0o600 writer.
      await this.removeLocalTempScreenshot(tempLocalFile);
      await this.writeScreenshot(finalPath, encoded);

      const totalDuration = this.timer.now() - startTime;
      logger.info(`[SCREENSHOT] File pull screenshot capture completed in ${totalDuration}ms`);

      result = {
        success: true,
        path: finalPath,
        screenshotImageSize: readImageHeaderDimensions(encoded) ?? undefined,
        ...metadataForScreenshotFormat(ANDROID_ADB_SCREENSHOT_METADATA, options.format),
      };
    } catch (err) {
      const totalDuration = this.timer.now() - startTime;
      const errorMsg = errorMessage(err);
      logger.warn(
        `[SCREENSHOT] File pull screenshot capture failed after ${totalDuration}ms: ${errorMsg}`,
      );

      // Clean up any temp files
      await this.removeLocalTempScreenshot(tempLocalFile);

      throw err;
    } finally {
      if (captureDispatched) {
        this.removeDeviceTempScreenshot(tempFile, "file-pull");
      }
    }

    return await this.cancelSuccessfulFilePullIfAborted(result, finalPath, signal);
  }

  private async cancelSuccessfulFilePullIfAborted(
    result: ScreenshotResult,
    finalPath: string,
    signal: AbortSignal | undefined,
  ): Promise<ScreenshotResult> {
    if (!signal?.aborted || !result.success) {
      return result;
    }

    // Cancellation can land while device cleanup is in flight. Remove the
    // completed frame so the latest-screenshot disk fallback cannot serve it.
    if (await this.fileSystem.pathExists(finalPath)) {
      await this.pathProtection.removeIfUnprotected(finalPath, async () => {
        await this.fileSystem.remove(finalPath);
        return true;
      });
    }
    return { success: false, error: OPERATION_CANCELLED_MESSAGE };
  }

  private hasFailedScreencap(stdout: string, stderr: string): boolean {
    return !/AM_SCREENCAP_RC:0(?:\s|$)/.test(stdout) || this.hasCommandError(stderr);
  }

  private sanitizeDeviceTempId(rawId: string): string {
    return screenshotTempIdToken(rawId);
  }

  private hasCommandError(stderr: string): boolean {
    return stderr.includes("error");
  }

  private async removeLocalTempScreenshot(tempLocalFile: string): Promise<void> {
    try {
      if (await this.fileSystem.pathExists(tempLocalFile)) {
        await this.fileSystem.remove(tempLocalFile);
      }
    } catch (cleanupErr) {
      logger.debug(`Failed to cleanup temp file: ${errorMessage(cleanupErr)}`);
    }
  }
}
