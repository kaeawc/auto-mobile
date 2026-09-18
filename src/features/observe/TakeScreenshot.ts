import { errorMessage } from "../../utils/describeUnknownError";
import { promises as fsPromises } from "node:fs";
import { pathExists } from "../../utils/filesystem/DefaultFileSystem";
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
import { selectScreenshotsToEvict, SCREENSHOT_MIN_EVICT_AGE_MS } from "./screenshotCacheEviction";
import { IOSCtrlProxyClient } from "./ios";
import { AndroidCtrlProxyClient } from "./android";
import type { CtrlProxyScreenshotResult } from "./ios/types";
import { getDeviceDataStreamServer } from "../../daemon/deviceDataStreamSocketServer";
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

function replaceScreenshotExtension(filePath: string, extension: string): string {
  return filePath.replace(/\.[^.]+$/, `.${extension}`);
}

export interface ScreenshotOptions {
  format?: "jpeg" | "png" | "webp";
  quality?: number;
  lossless?: boolean;
}

export class TakeScreenshot implements ScreenshotService {
  private readonly device: BootedDevice;
  private adb: AdbExecutor;
  private adbFactory: AdbClientFactory;
  private window: Window;
  private timer: Timer;
  private idGenerator: IdGenerator;
  private fileWriter: ScreenshotFileWriter;
  private static cacheDir: string | null = null;
  private static readonly MAX_CACHE_SIZE_BYTES = 128 * 1024 * 1024; // 128MB

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
  ) {
    this.device = device;
    this.adbFactory = adbFactory;
    this.adb = adbFactory.create(device);
    this.window = new Window(device, this.adbFactory);
    this.timer = timer;
    this.idGenerator = idGenerator;
    this.fileWriter = fileWriter;

    // Manage cache size (getCacheDir ensures directory exists with secure permissions)
    this.cleanupCache();
  }

  /**
   * Clean up the cache directory if it exceeds the maximum size
   */
  private async cleanupCache(): Promise<void> {
    try {
      const cacheDir = TakeScreenshot.getCacheDir();

      // Get all files in cache with their stats
      const files = await fsPromises.readdir(cacheDir);
      const fileStats = await Promise.all(
        files.map(async (file) => {
          const filePath = path.join(cacheDir, file);
          const stats = await fsPromises.stat(filePath);
          return { path: filePath, stats, mtime: stats.mtime.getTime() };
        }),
      );

      // Evict oldest-first until under the limit, but never a file young enough
      // to be an in-flight capture from another process sharing this dir (in
      // production each agent runs its own client process writing here).
      const toDelete = selectScreenshotsToEvict(
        fileStats.map((f) => ({ path: f.path, size: f.stats.size, mtimeMs: f.mtime })),
        TakeScreenshot.MAX_CACHE_SIZE_BYTES,
        SCREENSHOT_MIN_EVICT_AGE_MS,
        Date.now(),
      );
      for (const filePath of toDelete) {
        await fsPromises.unlink(filePath);
        logger.debug(`Removed cached screenshot: ${filePath}`);
      }
    } catch (err) {
      logger.warn("Failed to cleanup screenshot cache:", err);
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
        return await this.captureiOSScreenshot(finalPath, signal);
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

    if (options.format === undefined || options.format === "jpeg") {
      try {
        return await this.captureScreenshotViaCtrlProxy(finalPath, signal);
      } catch (error) {
        logger.info(`[SCREENSHOT] CtrlProxy capture failed, falling back to ADB: ${error}`);
        finalPath = replaceScreenshotExtension(finalPath, "png");
        options = { ...options, format: "png" };
      }
    }

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

  /**
   * Run the CtrlProxy screenshot request under the caller's cancellation.
   *
   * @returns the capture, or null when the caller cancelled instead.
   */
  private async requestCtrlProxyCapture(
    signal?: AbortSignal,
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
        client.requestScreenshot(10000, undefined, false, signal),
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
  ): Promise<ScreenshotResult> {
    const result = await this.requestCtrlProxyCapture(signal);
    if (!result) {
      return { success: false, error: OPERATION_CANCELLED_MESSAGE };
    }
    if (!result.success || !result.data) {
      throw new Error(result.error || "No screenshot data returned from Android CtrlProxy");
    }

    const format = result.format?.toLowerCase() === "png" ? "png" : "jpeg";
    const imageBuffer = Buffer.from(result.data, "base64");
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
      return await this.writeiOSScreenshot(finalPath, result, startTime, signal);
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
    signal?: AbortSignal,
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
    await this.fileWriter.write(finalPath, imageBuffer);
    if (signal?.aborted) {
      // A cancellation can land while the write is in flight. Remove the frame
      // so findLatestScreenshotPath(deviceId) cannot surface it as current (#6605).
      await this.fileWriter.remove(finalPath);
      return { success: false, error: OPERATION_CANCELLED_MESSAGE };
    }

    const durationMs = this.timer.now() - startTime;
    logger.info(`[SCREENSHOT] iOS screenshot captured in ${durationMs}ms, saved to ${finalPath}`);

    // Push to observation stream for IDE plugins
    this.pushScreenshotToStream(result.data, imageBuffer);

    return {
      success: true,
      path: finalPath,
      ...IOS_CTRLPROXY_SCREENSHOT_METADATA,
    };
  }

  /**
   * Push screenshot to the device data stream for IDE plugins.
   */
  private pushScreenshotToStream(base64Data: string, imageBuffer: Buffer): void {
    const server = getDeviceDataStreamServer();
    if (!server) {
      return;
    }

    // Try to get dimensions from the image
    let width = 1080;
    let height = 2340;

    try {
      // PNG header contains dimensions at bytes 16-24
      if (imageBuffer.length >= 24 && imageBuffer[0] === 0x89 && imageBuffer[1] === 0x50) {
        width = imageBuffer.readUInt32BE(16);
        height = imageBuffer.readUInt32BE(20);
      }
    } catch {
      // Use defaults if we can't read dimensions
    }

    try {
      server.pushScreenshotUpdate(
        this.device.deviceId,
        base64Data,
        width,
        height,
        this.device.platform === "ios"
          ? IOS_CTRLPROXY_SCREENSHOT_METADATA
          : ANDROID_ADB_SCREENSHOT_METADATA,
      );
    } catch (error) {
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
  ): Promise<ScreenshotResult> {
    const startTime = this.timer.now();
    logger.info(`[SCREENSHOT] Trying base64 approach`);

    const cmdStartTime = this.timer.now();
    const tempFile = "/sdcard/screenshot.png";

    // Single command: screencap -> base64 encode -> remove temp file
    const command = `shell "screencap -p ${tempFile} && base64 ${tempFile} && rm ${tempFile}"`;
    // Use larger maxBuffer (50MB) to handle high-resolution screenshots
    const maxBuffer = 50 * 1024 * 1024; // 50MB
    const result = await this.adb.executeCommand(command, undefined, maxBuffer, undefined, signal);
    const cmdDuration = this.timer.now() - cmdStartTime;
    logger.info(`[SCREENSHOT] Combined ADB command took ${cmdDuration}ms`);

    if (!result.stdout || result.stdout.trim().length === 0) {
      throw new Error("No base64 data received from screencap command");
    }

    // Decode base64 data to buffer
    const decodeStartTime = this.timer.now();
    const cleanedOutput = result.stdout.replace(/[\r\n]/g, "");
    const imageBuffer = Buffer.from(cleanedOutput, "base64");
    const decodeDuration = this.timer.now() - decodeStartTime;
    logger.info(
      `[SCREENSHOT] Base64 decode took ${decodeDuration}ms, buffer size: ${imageBuffer.length} bytes`,
    );

    // Handle format conversion and save securely
    if (options.format !== "webp") {
      // For PNG, save directly
      const saveStartTime = this.timer.now();
      await this.fileWriter.write(finalPath, imageBuffer);
      const saveDuration = this.timer.now() - saveStartTime;
      logger.info(`[SCREENSHOT] PNG file save took ${saveDuration}ms`);
    } else {
      // Convert to WebP
      const convertStartTime = this.timer.now();
      const image = Image.fromBuffer(imageBuffer);
      const transformer = image.webp({
        quality: options.quality || 75,
        lossless: options.lossless,
      });
      const convertedImage = await transformer.toBuffer();
      const convertDuration = this.timer.now() - convertStartTime;
      logger.info(`[SCREENSHOT] WebP conversion took ${convertDuration}ms`);

      // Save the webp file securely
      const saveStartTime = this.timer.now();
      await this.fileWriter.write(finalPath, convertedImage);
      const saveDuration = this.timer.now() - saveStartTime;
      logger.info(`[SCREENSHOT] WebP file save took ${saveDuration}ms`);
    }

    const totalDuration = this.timer.now() - startTime;
    logger.info(`[SCREENSHOT] Base64 screenshot capture completed in ${totalDuration}ms`);

    return {
      success: true,
      path: finalPath,
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
      const screencapResult = await this.adb.executeCommand(
        `shell "screencap -p ${shellQuote(tempFile)} ; echo AM_SCREENCAP_RC:$?"`,
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
      const imageBuffer = await fsPromises.readFile(tempLocalFile);
      const readDuration = this.timer.now() - readStartTime;
      logger.info(
        `[SCREENSHOT] File read took ${readDuration}ms, buffer size: ${imageBuffer.length} bytes`,
      );

      // Step 5: Handle format conversion and save to final path
      if (options.format !== "webp") {
        // For PNG, move the temp file to final path
        const saveStartTime = this.timer.now();
        await fsPromises.rename(tempLocalFile, finalPath);
        const saveDuration = this.timer.now() - saveStartTime;
        logger.info(`[SCREENSHOT] PNG file move took ${saveDuration}ms`);
      } else {
        // Convert to WebP
        const convertStartTime = this.timer.now();
        const image = Image.fromBuffer(imageBuffer);
        const transformer = image.webp({
          quality: options.quality || 75,
          lossless: options.lossless,
        });
        const convertedImage = await transformer.toBuffer();
        const convertDuration = this.timer.now() - convertStartTime;
        logger.info(`[SCREENSHOT] WebP conversion took ${convertDuration}ms`);

        // Save the webp file securely and remove temp file
        const saveStartTime = this.timer.now();
        await this.fileWriter.write(finalPath, convertedImage);
        await fsPromises.rm(tempLocalFile, { recursive: true, force: true });
        const saveDuration = this.timer.now() - saveStartTime;
        logger.info(`[SCREENSHOT] WebP file save took ${saveDuration}ms`);
      }

      const totalDuration = this.timer.now() - startTime;
      logger.info(`[SCREENSHOT] File pull screenshot capture completed in ${totalDuration}ms`);

      result = {
        success: true,
        path: finalPath,
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
    if (await pathExists(finalPath)) {
      await fsPromises.rm(finalPath, { recursive: true, force: true });
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
      if (await pathExists(tempLocalFile)) {
        await fsPromises.rm(tempLocalFile, { recursive: true, force: true });
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
