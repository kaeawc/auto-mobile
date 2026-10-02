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
import {
  selectScreenshotsToEvict,
  screenshotPathKey,
  SCREENSHOT_MIN_LIFETIME_MS,
  SCREENSHOT_CACHE_MAX_SIZE_BYTES,
  SCREENSHOT_STALE_AGE_MS,
  type ScreenshotCacheFile,
} from "./screenshotCacheEviction";
import {
  screenshotPathProtection,
  type ScreenshotPathProtection,
} from "./ScreenshotPathProtection";
import { IOSCtrlProxyClient } from "./ios";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
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
import { getObserveCacheStore } from "./cache/ObserveCacheRegistry";
import { getScreenshotStateStore } from "./screenshot/ScreenshotStateRegistry";
import {
  AndroidPhysicalDisplayIdResolver,
  assertValidPng,
  decodePngBase64Output,
  withAndroidScreenshotCaptureLock,
} from "./android/AndroidPhysicalDisplayId";
import { readImageHeaderDimensions } from "../../utils/screenshot/imageHeaderDimensions";
import { displayTransitions } from "./DisplayTransition";
import { combineWithAmbientAbort } from "../../utils/AbortContext";
import { raceWithDeadline } from "../../utils/raceWithDeadline";

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
    if (isIosSimulatorUdid(this.device.deviceId)) {
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
  private readonly physicalDisplayIdResolver: AndroidPhysicalDisplayIdResolver;
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
    physicalDisplayIdResolver: AndroidPhysicalDisplayIdResolver = new AndroidPhysicalDisplayIdResolver(
      {
        timer,
      },
    ),
    cleanupOnCreate = true,
    private readonly pathProtection: ScreenshotPathProtection = screenshotPathProtection,
  ) {
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
    if (cleanupOnCreate) {
      void this.cleanupCache();
    }
  }

  /** Sweep stale files on the first construction and every subsequent cleanup pass. */
  private async cleanupCache(): Promise<void> {
    try {
      const cacheDir = this.cacheDirResolver();
      const names = await this.fileSystem.readdir(cacheDir);
      const candidates = names.filter((name) =>
        /^(?:screenshot_.+\.(?:png|jpe?g|webp)(?:\.temp)?|snapshot-of-.+\.png|crop-[A-Za-z0-9_-]+\.png)$/.test(
          name,
        ),
      );
      let files = (
        await Promise.all(
          candidates.map((name) => this.readCachedScreenshot(path.join(cacheDir, name))),
        )
      ).filter((file): file is ScreenshotCacheFile => file !== undefined);
      const referencedPaths = new Set(
        [
          ...getScreenshotStateStore().getReferencedScreenshotPaths(),
          ...(await getObserveCacheStore().getReferencedScreenshotPaths()),
        ].map((filePath) => screenshotPathKey(filePath)),
      );
      const isReferenced = (filePath: string): boolean =>
        referencedPaths.has(screenshotPathKey(filePath));
      const isProtected = (filePath: string): boolean => this.pathProtection.isProtected(filePath);
      const nowMs = this.timer.now();
      const stale = files.filter((file) => nowMs - file.mtimeMs > SCREENSHOT_STALE_AGE_MS);
      files = await this.evictCandidates(
        stale.map((file) => file.path),
        files,
        isReferenced,
      );
      const evictionPlan = selectScreenshotsToEvict(
        files,
        SCREENSHOT_CACHE_MAX_SIZE_BYTES,
        SCREENSHOT_MIN_LIFETIME_MS,
        nowMs,
        isReferenced,
        isProtected,
      );
      files = await this.evictCandidates(evictionPlan.toEvict, files, isReferenced);
      if (files.reduce((total, file) => total + file.size, 0) > SCREENSHOT_CACHE_MAX_SIZE_BYTES) {
        logger.warn(
          `Screenshot cache remains over budget after eviction; skipped ${evictionPlan.skippedReferenced} referenced screenshots; ${files.filter((file) => isProtected(file.path)).length} protected screenshots`,
        );
      }
    } catch (error) {
      logger.warn("Failed to cleanup screenshot cache:", error);
    }
  }

  private async readCachedScreenshot(filePath: string): Promise<ScreenshotCacheFile | undefined> {
    try {
      // lstat excludes symlinks; legacy injected filesystems without it must
      // explicitly identify plain files through stat.isFile instead.
      const stats = await (this.fileSystem.lstat?.(filePath) ?? this.fileSystem.stat(filePath));
      return stats.isFile?.() === true
        ? { path: filePath, size: stats.size, mtimeMs: stats.mtimeMs }
        : undefined;
    } catch (error) {
      logger.warn(`Failed to stat screenshot during cleanup: ${filePath}`, error);
      return undefined;
    }
  }

  private async evictCandidates(
    candidates: string[],
    files: ScreenshotCacheFile[],
    isReferenced: (path: string) => boolean,
  ): Promise<ScreenshotCacheFile[]> {
    const removed = new Set<string>();
    for (const filePath of candidates) {
      // Recheck after every await: a path may have been returned since selection.
      if (isReferenced(filePath)) {
        continue;
      }
      const deleted = await this.pathProtection.removeIfUnprotected(filePath, () => {
        // Screenshot completion can add a cache reference after plan selection.
        if (
          getScreenshotStateStore()
            .getReferencedScreenshotPaths()
            .some(
              (referencedPath) => screenshotPathKey(referencedPath) === screenshotPathKey(filePath),
            )
        ) {
          return Promise.resolve(false);
        }
        return this.removeCachedScreenshot(filePath);
      });
      if (deleted) {
        removed.add(filePath);
      }
    }
    return files.filter((file) => !removed.has(file.path));
  }

  private async removeCachedScreenshot(filePath: string): Promise<boolean> {
    try {
      await this.fileSystem.unlink(filePath);
      logger.debug(`Removed cached screenshot: ${filePath}`);
      return true;
    } catch (error) {
      logger.warn(`Failed to remove cached screenshot: ${filePath}`, error);
      return false;
    }
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
      TakeScreenshot.getCacheDir(),
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
      logger.warn(`[SCREENSHOT] Execute failed after ${totalDuration}ms: ${errorMsg}`);
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
      return `-d ${options.displayId} `;
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
        client.requestScreenshot(10000, undefined, false, signal, displayId),
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
    await this.fileWriter.write(screenshotPath, imageBuffer);
    if (signal?.aborted) {
      // Cancellation can land while the write is in flight: the request is over,
      // so drop the frame instead of leaving it for the latest-screenshot disk
      // fallback to serve as the device's current screen (#6605).
      await this.fileWriter.remove(screenshotPath);
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
      const result = await awaitWhileRequestIsLive(
        client.requestScreenshot(10000, undefined, signal),
        signal,
      );
      return await this.writeiOSScreenshot(finalPath, result, startTime, options, signal);
    } catch (error) {
      const errorMsg = errorMessage(error);
      logger.error(`[SCREENSHOT] iOS screenshot capture failed: ${errorMsg}`);
      return {
        success: false,
        error: errorMsg,
      };
    }
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
    await this.fileWriter.write(finalPath, encoded);
    if (signal?.aborted) {
      // A cancellation can land while the write is in flight. Remove the frame
      // so findLatestScreenshotPath(deviceId) cannot surface it as current (#6605).
      await this.fileWriter.remove(finalPath);
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
    const result = await withAndroidScreenshotCaptureLock(this.device.deviceId, () => {
      throwIfAborted(signal);
      return this.adb.executeCommand(command, undefined, maxBuffer, undefined, signal);
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
    await this.fileWriter.write(finalPath, encoded);
    if (signal?.aborted) {
      await this.fileWriter.remove(finalPath);
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

    try {
      // Use file pull approach instead of base64 to avoid stdout buffer issues
      const cmdStartTime = this.timer.now();

      // Step 1: Take screenshot on device
      const displayArgument = await this.screencapDisplayArgument(options, signal);
      throwIfAborted(signal);
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

      let writtenBuffer = imageBuffer;
      if (options.format === undefined || options.format === "png") {
        // ADB screencap is already PNG. Preserve the original file-pull move.
        await this.fileSystem.rename(tempLocalFile, finalPath);
      } else {
        const encoded = await encodeScreenshot(imageBuffer, encodingOptions(options));
        await this.fileWriter.write(finalPath, encoded);
        writtenBuffer = encoded;
        await this.fileSystem.remove(tempLocalFile);
      }

      const totalDuration = this.timer.now() - startTime;
      logger.info(`[SCREENSHOT] File pull screenshot capture completed in ${totalDuration}ms`);

      result = {
        success: true,
        path: finalPath,
        screenshotImageSize: readImageHeaderDimensions(writtenBuffer) ?? undefined,
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
      await this.removeDeviceTempScreenshot(tempFile);
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
      await this.fileSystem.remove(finalPath);
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

  private async removeDeviceTempScreenshot(tempFile: string): Promise<void> {
    try {
      // Cleanup cannot change the completed capture result, so it is safe to swallow its failure.
      await this.adb.executeCommand(`shell rm -f ${shellQuote(tempFile)}`);
    } catch (error) {
      logger.debug(`[SCREENSHOT] Failed to remove device temp screenshot ${tempFile}: ${error}`);
    }
  }
}
