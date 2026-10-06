import { errorMessage } from "../../utils/describeUnknownError";
import {
  AdbClientFactory,
  defaultAdbClientFactory,
} from "../../utils/android-cmdline-tools/AdbClientFactory";
import type { AdbExecutor } from "../../utils/android-cmdline-tools/interfaces/AdbExecutor";
import { BootedDevice, PostNotificationResult } from "../../models";
import { Window } from "../observe/Window";
import type { Window as WindowInterface } from "../observe/interfaces/Window";
import { logger } from "../../utils/logger";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { SimCtlClient } from "../../utils/ios-cmdline-tools/SimCtlClient";
import { resolveIosDeviceKind } from "../../utils/ios-cmdline-tools/IosDeviceKind";
import { fileURLToPath } from "url";
import path from "path";
import { DefaultFileSystem, type FileSystem } from "../../utils/filesystem/DefaultFileSystem";
import { detectImageMimeType } from "../../utils/screenshot/imageHeaderDimensions";
import { shellQuote } from "../../utils/shellQuote";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";
import { ANDROID_PACKAGE_NAME_PATTERN } from "../../utils/androidPackageName";

export { ANDROID_PACKAGE_NAME_PATTERN } from "../../utils/androidPackageName";

interface PostNotificationAction {
  label: string;
  actionId: string;
}

export interface PostNotificationOptions {
  title: string;
  body: string;
  imageType?: "normal" | "bigPicture";
  imagePath?: string;
  actions?: PostNotificationAction[];
  channelId?: string;
  /** Android package name or iOS bundle identifier to target; required on iOS. */
  appId?: string;
}

const NOTIFICATION_ACTION = "dev.jasonpearson.automobile.sdk.NOTIFICATION_POST";
const NOTIFICATION_RECEIVER =
  "dev.jasonpearson.automobile.sdk.notifications.AutoMobileNotificationReceiver";
const SDK_RESULT_FAILURE = 0;
const SDK_RESULT_SUCCESS = 1;
/**
 * Receiver result code: the notification was posted but the requested big picture could not be
 * loaded by the app, so it fell back to big-text style (issue #10014). The SDK emits it for an
 * image-less bigPicture post; the host maps it to a warning. Older SDKs only send 0/1, which this
 * host still handles unchanged. Any other code is unknown to this host and fails closed (see
 * `mapSdkResultCode`): a host older than the app's SDK cannot know a newer code's meaning, so
 * update the host first (docs/tools.md, "postNotification SDK compatibility").
 */
const SDK_RESULT_POSTED_WITHOUT_IMAGE = 2;
/** Largest image file pushed to the device; bigPicture bitmaps beyond this are not worth decoding in a notification. */
const NOTIFICATION_IMAGE_MAX_BYTES = 16 * 1024 * 1024;
/** Leading bytes the format sniffer needs (the ISO-BMFF `ftyp` box brand ends at byte 12). */
const NOTIFICATION_IMAGE_HEADER_BYTES = 32;
const IMAGE_PATH_IGNORED_WARNING =
  'imagePath was ignored because imageType is not "bigPicture"; set imageType to "bigPicture" to show the image.';
const POSTED_WITHOUT_IMAGE_WARNING =
  "The notification was posted but the app could not load the bigPicture image, so it was shown without it (the app may lack read access to the pushed file under /sdcard/Download/automobile).";
const DEVICE_IMAGE_DIR = "/sdcard/Download/automobile";
const NOTIFICATION_IMAGE_PUSH_TIMEOUT_MS = 60_000;
const NOTIFICATION_AUTHORIZATION_GUIDANCE =
  "The app has not been granted notification authorization on this simulator; launch the app and accept its notification prompt (or have the app call requestAuthorization) before calling postNotification.";

function isNotificationAuthorizationError(error: string): boolean {
  return (
    error.includes("Source is not authorized") ||
    (error.includes("UNErrorDomain") && /\bcode\s*=\s*2003\b/.test(error))
  );
}

function preserveOrExplainSimctlPushError(error: string): string {
  if (isNotificationAuthorizationError(error)) {
    return `${NOTIFICATION_AUTHORIZATION_GUIDANCE} simctl error: ${error}`;
  }
  return error;
}

export class PostNotification {
  private device: BootedDevice;
  private adb: AdbExecutor;
  private adbFactory: AdbClientFactory;
  private window: WindowInterface;
  private simctl: SimCtlClient;
  private fileSystem: FileSystem;

  constructor(
    device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = defaultAdbClientFactory,
    window: WindowInterface | null = null,
    simctl: SimCtlClient | null = null,
    fileSystem: FileSystem | null = null,
  ) {
    this.device = device;
    this.fileSystem = fileSystem ?? new DefaultFileSystem();
    // Detect if the argument is a factory (has create method) or an executor
    if (
      adbFactoryOrExecutor &&
      typeof (adbFactoryOrExecutor as AdbClientFactory).create === "function"
    ) {
      this.adbFactory = adbFactoryOrExecutor as AdbClientFactory;
      this.adb = this.adbFactory.create(device);
    } else if (adbFactoryOrExecutor) {
      // Legacy path: wrap the executor in a factory for downstream dependencies
      const executor = adbFactoryOrExecutor as AdbExecutor;
      this.adb = executor;
      this.adbFactory = { create: () => executor };
    } else {
      this.adbFactory = defaultAdbClientFactory;
      this.adb = this.adbFactory.create(device);
    }
    this.window = window || new Window(device, this.adbFactory);
    this.simctl = simctl || new SimCtlClient(device);
  }

  async execute(
    options: PostNotificationOptions,
    signal?: AbortSignal,
  ): Promise<PostNotificationResult> {
    const perf = createGlobalPerformanceTracker();
    perf.serial("postNotification");

    try {
      switch (this.device.platform) {
        case "android":
          return await this.executeAndroid(options, signal);
        case "ios":
          return await this.executeIos(options);
        default:
          return {
            success: false,
            supported: false,
            error: `postNotification is not supported on platform: ${this.device.platform}`,
          };
      }
    } catch (error) {
      logger.warn(`Failed to post notification: ${errorMessage(error)}`, error);
      return {
        success: false,
        supported: false,
        error: `Failed to post notification: ${errorMessage(error)}`,
      };
    } finally {
      perf.end();
    }
  }

  /** iOS: deliver a simulated remote push via `simctl push` (simulator only). */
  private async executeIos(options: PostNotificationOptions): Promise<PostNotificationResult> {
    const bundleId = options.appId;
    if (!bundleId) {
      return {
        success: false,
        supported: false,
        error: "appId (bundle identifier) is required to post a notification on iOS.",
      };
    }

    // simctl push is simulator-only. Gate on the device backend kind.
    if (resolveIosDeviceKind({ deviceId: this.device.deviceId }) === "physical") {
      return {
        success: false,
        supported: false,
        appId: bundleId,
        error:
          "postNotification on iOS is only supported on simulators (simctl push); physical iOS devices are not supported.",
      };
    }

    const warnings: string[] = [];
    if (options.imageType === "bigPicture" || options.imagePath) {
      warnings.push(
        "bigPicture/image attachments are not supported via simctl push and were ignored.",
      );
    }
    if (options.actions && options.actions.length > 0) {
      warnings.push(
        "action buttons require a pre-registered UNNotificationCategory and were ignored.",
      );
    }
    const warning = warnings.join(" ") || undefined;

    const aps: Record<string, unknown> = {
      alert: { title: options.title, body: options.body },
      sound: "default",
    };
    if (options.channelId) {
      aps.category = options.channelId; // reuse channelId as the APNs category
    }
    const payload = { "Simulator Target Bundle": bundleId, aps };
    const json = JSON.stringify(payload);

    if (Buffer.byteLength(json, "utf8") > 4096) {
      return {
        success: false,
        supported: true,
        appId: bundleId,
        error: "APNs payload exceeds the 4096-byte simctl push limit.",
        warning,
      };
    }

    const result = await this.simctl.pushNotification(this.device.deviceId, bundleId, json);
    if (!result.success) {
      return {
        success: false,
        supported: true,
        appId: bundleId,
        error: preserveOrExplainSimctlPushError(result.error ?? "simctl push failed."),
        warning,
      };
    }
    return {
      success: true,
      supported: true,
      method: "simctlPush",
      appId: bundleId,
      channelId: options.channelId,
      warning,
    };
  }

  /** Android: post a local notification through the AutoMobile SDK BroadcastReceiver. */
  private async executeAndroid(
    options: PostNotificationOptions,
    signal?: AbortSignal,
  ): Promise<PostNotificationResult> {
    try {
      const imageType = options.imageType ?? "normal";

      let imagePath: string | undefined;
      let hostWarning: string | undefined;
      if (imageType === "bigPicture") {
        if (!options.imagePath) {
          return {
            success: false,
            supported: false,
            imageType,
            error: "imagePath is required for bigPicture imageType notifications.",
          };
        }

        const prepared = await this.prepareDeviceImagePath(options.imagePath, signal);
        if (!prepared.success) {
          return {
            success: false,
            supported: false,
            imageType,
            error: prepared.error,
          };
        }
        imagePath = prepared.devicePath;
        hostWarning = prepared.warning;
      } else if (options.imagePath) {
        // Only the bigPicture style displays an image, so the host path is neither pushed nor
        // sent to the device; say so instead of reporting a clean success (issue #10014).
        hostWarning = IMAGE_PATH_IGNORED_WARNING;
      }

      const sdkResult = await this.trySdkPost({ ...options, imagePath }, imageType, signal);
      const warning = [hostWarning, sdkResult.warning].filter(Boolean).join(" ") || undefined;
      return warning === sdkResult.warning ? sdkResult : { ...sdkResult, warning };
    } catch (error) {
      logger.warn(`Failed to post notification: ${errorMessage(error)}`, error);
      return {
        success: false,
        supported: false,
        error: `Failed to post notification: ${errorMessage(error)}`,
      };
    }
  }

  private async trySdkPost(
    options: PostNotificationOptions,
    imageType: "normal" | "bigPicture",
    signal?: AbortSignal,
  ): Promise<PostNotificationResult> {
    const appId = options.appId ?? (await this.getLiveActiveAppId());
    if (!appId) {
      return {
        success: false,
        supported: false,
        imageType,
        error: "Unable to determine the active app for SDK notifications.",
      };
    }
    if (!ANDROID_PACKAGE_NAME_PATTERN.test(appId)) {
      return {
        success: false,
        supported: false,
        imageType,
        error: "Invalid Android appId. Provide an Android package name such as com.example.app.",
      };
    }

    const style = imageType === "bigPicture" ? "bigPicture" : "default";
    const extras = this.buildBroadcastExtras(options, style);
    const component = `${appId}/${NOTIFICATION_RECEIVER}`;
    const command =
      `shell am broadcast -n ${component} -a ${NOTIFICATION_ACTION} ${extras.join(" ")}`.trim();

    const probeCommand = `shell cmd package query-receivers --brief -a ${NOTIFICATION_ACTION} -p ${shellQuote(appId)}`;
    try {
      const probeResult = await this.adb.executeCommand(
        probeCommand,
        undefined,
        undefined,
        true,
        signal,
      );
      const probeOutput = `${probeResult.stdout}\n${probeResult.stderr}`;
      const probeVerdict = this.parseReceiverProbe(probeOutput, appId);
      if (probeVerdict === "absent") {
        return {
          success: false,
          supported: false,
          imageType,
          appId,
          error: "AutoMobile notification receiver not found in the target app.",
        };
      }
      if (probeVerdict === "unknown") {
        // Safe to fall through because inconclusive probe output can be an unsupported older-API subcommand; broadcast detection is the fallback.
        logger.debug(
          `[PostNotification] SDK receiver probe output was inconclusive; falling back to broadcast`,
        );
      }
    } catch (error) {
      // Safe to swallow because older API levels lack this best-effort subcommand; broadcast detection is the fallback.
      logger.debug(`[PostNotification] SDK receiver probe failed: ${error}`);
    }

    try {
      const result = await this.adb.executeCommand(command, undefined, undefined, true, signal);
      const output = `${result.stdout}\n${result.stderr}`;

      if (this.isReceiverUnavailable(output)) {
        return {
          success: false,
          supported: false,
          imageType,
          appId,
          error: "AutoMobile notification receiver not found in the target app.",
        };
      }

      return this.mapSdkResultCode(this.parseBroadcastResultCode(output), {
        success: false,
        supported: true,
        method: "sdk",
        imageType,
        appId,
        channelId: options.channelId,
      });
    } catch (error) {
      logger.warn(`[PostNotification] SDK broadcast failed: ${error}`);
      return {
        success: false,
        supported: true,
        method: "sdk",
        imageType,
        appId,
        channelId: options.channelId,
        error: `SDK notification broadcast failed: ${errorMessage(error)}`,
      };
    }
  }

  /** Maps the receiver's broadcast result code onto the tool result; `base` carries the identity fields. */
  private mapSdkResultCode(
    resultCode: number | null,
    base: PostNotificationResult,
  ): PostNotificationResult {
    if (resultCode === SDK_RESULT_SUCCESS) {
      return { ...base, success: true };
    }
    if (resultCode === SDK_RESULT_POSTED_WITHOUT_IMAGE) {
      return { ...base, success: true, warning: POSTED_WITHOUT_IMAGE_WARNING };
    }
    if (resultCode === null) {
      return { ...base, error: "SDK notification broadcast did not return a result code." };
    }
    if (resultCode === SDK_RESULT_FAILURE) {
      return { ...base, error: "SDK notification receiver reported a failure." };
    }
    // A code this host does not know comes from an SDK newer than the host. It may mean the
    // notification was posted, but guessing success could hide a real failure, so fail closed and
    // name the code and the fix.
    return {
      ...base,
      error: `SDK notification receiver returned result code ${resultCode}, which this AutoMobile host does not recognize. The app's SDK is likely newer than this host; update AutoMobile (the host) to the latest version. The notification may already have been posted, so check the device before retrying.`,
    };
  }

  private buildBroadcastExtras(
    options: PostNotificationOptions,
    style: "default" | "bigPicture",
  ): string[] {
    const extras: string[] = [];

    extras.push(`--es ${AutoMobileNotificationExtras.title} ${quoteForShell(options.title)}`);
    extras.push(`--es ${AutoMobileNotificationExtras.body} ${quoteForShell(options.body)}`);

    if (style !== "default") {
      extras.push(`--es ${AutoMobileNotificationExtras.style} ${quoteForShell(style)}`);
    }

    if (options.imagePath) {
      extras.push(
        `--es ${AutoMobileNotificationExtras.imagePath} ${quoteForShell(options.imagePath)}`,
      );
    }

    if (options.actions && options.actions.length > 0) {
      extras.push(
        `--es ${AutoMobileNotificationExtras.actions} ${quoteForShell(JSON.stringify(options.actions))}`,
      );
    }

    if (options.channelId) {
      extras.push(
        `--es ${AutoMobileNotificationExtras.channelId} ${quoteForShell(options.channelId)}`,
      );
    }

    return extras;
  }

  private parseBroadcastResultCode(output: string): number | null {
    const match = output.match(/Broadcast completed: result=(-?\d+)/i);
    if (!match) {
      return null;
    }
    const parsed = Number.parseInt(match[1], 10);
    return Number.isNaN(parsed) ? null : parsed;
  }

  private parseReceiverProbe(output: string, appId: string): "present" | "absent" | "unknown" {
    const expectedComponents = [`${appId}/${NOTIFICATION_RECEIVER}`];
    if (NOTIFICATION_RECEIVER.startsWith(`${appId}.`)) {
      expectedComponents.push(`${appId}/${NOTIFICATION_RECEIVER.slice(appId.length)}`);
    }
    const outputTokens = output.split(/\s+/);
    if (expectedComponents.some((component) => outputTokens.includes(component))) {
      return "present";
    }
    if (
      /no receivers found/i.test(output) ||
      (/\d+\s+receivers?\s+found/i.test(output) &&
        !expectedComponents.some((component) => outputTokens.includes(component)))
    ) {
      return "absent";
    }
    return "unknown";
  }

  private isReceiverUnavailable(output: string): boolean {
    const lower = output.toLowerCase();
    return (
      lower.includes("no receiver") ||
      lower.includes("no receivers") ||
      lower.includes("does not exist") ||
      lower.includes("securityexception")
    );
  }

  private async prepareDeviceImagePath(
    imagePath: string,
    signal?: AbortSignal,
  ): Promise<
    { success: true; devicePath: string; warning?: string } | { success: false; error: string }
  > {
    const trimmed = imagePath.trim();
    if (trimmed.startsWith("data:") || trimmed.startsWith("base64:")) {
      return {
        success: false,
        error: "Base64 image payloads are not supported. Provide a host file path instead.",
      };
    }

    const sourcePath = this.resolveHostPath(trimmed);
    if (!sourcePath) {
      return {
        success: false,
        error: "imagePath must be a valid host file path.",
      };
    }

    const validation = await this.validateHostImage(sourcePath);
    if (validation.error) {
      return { success: false, error: validation.error };
    }

    const fileName = path.basename(sourcePath);
    const devicePath = `${DEVICE_IMAGE_DIR}/${fileName}`;

    try {
      await this.adb.executeCommand(
        `shell mkdir -p ${DEVICE_IMAGE_DIR}`,
        undefined,
        undefined,
        true,
        signal,
      );
      await this.adb.executeCommand(
        `push ${quoteForAdbArg(sourcePath)} ${quoteForAdbArg(devicePath)}`,
        NOTIFICATION_IMAGE_PUSH_TIMEOUT_MS,
        undefined,
        true,
        signal,
      );
      return { success: true, devicePath, warning: validation.warning };
    } catch (error) {
      logger.warn(`Failed to push image to device: ${errorMessage(error)}`, error);
      return {
        success: false,
        error: `Failed to push image to device: ${errorMessage(error)}`,
      };
    }
  }

  /**
   * Checks the host file before it is pushed: an actionable `error` when it cannot be shown as a
   * notification image, or a `warning` when it is a format only some Android versions decode.
   * Only the file's size and its first bytes are inspected, never the whole file.
   */
  private async validateHostImage(
    sourcePath: string,
  ): Promise<{ error?: string; warning?: string }> {
    let stats;
    try {
      stats = await this.fileSystem.stat(sourcePath);
    } catch (error) {
      logger.warn(`Image file not found at ${sourcePath}: ${errorMessage(error)}`, error);
      return { error: `Image file not found at ${sourcePath}` };
    }

    if (stats.isFile && !stats.isFile()) {
      return { error: `Image path is not a file: ${sourcePath}` };
    }
    if (stats.size === 0) {
      return { error: `Image file is empty: ${sourcePath}` };
    }
    if (stats.size > NOTIFICATION_IMAGE_MAX_BYTES) {
      return {
        error: `Image file is too large at ${sourcePath} (${(stats.size / (1024 * 1024)).toFixed(1)} MiB); bigPicture images must be at most ${NOTIFICATION_IMAGE_MAX_BYTES / (1024 * 1024)} MiB. Resize or compress the image and try again.`,
      };
    }

    let head: Buffer;
    try {
      head = await this.fileSystem.readFileHead(sourcePath, NOTIFICATION_IMAGE_HEADER_BYTES);
    } catch (error) {
      logger.warn(`Image file is not readable at ${sourcePath}: ${errorMessage(error)}`, error);
      return { error: `Image file is not readable at ${sourcePath}: ${errorMessage(error)}` };
    }
    const format = classifyNotificationImage(head);
    if (format === null) {
      return {
        error: `Unsupported image type at ${sourcePath}; bigPicture notifications need a PNG, JPEG, WebP, GIF, BMP, HEIF/HEIC, or AVIF file.`,
      };
    }
    return format === "common" ? {} : { warning: VERSION_DEPENDENT_IMAGE_WARNINGS[format] };
  }

  private resolveHostPath(imagePath: string): string | null {
    if (imagePath.startsWith("file://")) {
      try {
        return fileURLToPath(imagePath);
      } catch (error) {
        logger.warn(`[PostNotification] Failed to parse file URL: ${error}`);
        return null;
      }
    }

    if (imagePath.startsWith("content://") || imagePath.startsWith("/sdcard")) {
      return null;
    }

    return resolvePathFromDaemonLaunchWorkingDirectory(imagePath);
  }

  private async getLiveActiveAppId(): Promise<string | null> {
    try {
      const active = await this.window.getActive(true);
      return active?.appId ?? null;
    } catch (error) {
      logger.warn(`[PostNotification] Failed to read active window: ${error}`);
      return null;
    }
  }
}

/**
 * Images Android decodes on every API level the SDK supports (minSdk 24): PNG, JPEG, WebP, GIF and
 * BMP. HEIF/HEIC (Android 8.0+) and AVIF (Android 14+) are decoded only on newer devices, so they
 * pass with a warning instead of being refused: the host does not know the device's API level, and
 * the app falls back to showing the notification without the image (result code 2) when it cannot
 * decode them. Source: the "Supported media formats" image table at
 * https://developer.android.com/media/platform/supported-formats (fetched 2026-10-05). ICO and
 * WBMP are also decoded by BitmapFactory but have no reliable signature and are not sniffed.
 */
type NotificationImageFormat = "common" | "heif" | "avif";

const HEIF_BRANDS = new Set(["heic", "heix", "hevc", "hevx", "heim", "heis", "mif1", "msf1"]);
const AVIF_BRANDS = new Set(["avif", "avis"]);

const VERSION_DEPENDENT_IMAGE_WARNINGS: Record<"heif" | "avif", string> = {
  heif: "HEIF/HEIC images are decoded by Android 8.0 (API 26) and newer; on an older device the app cannot load the image and shows the notification without it.",
  avif: "AVIF images are decoded by Android 14 (API 34) and newer according to Android's supported-formats table; on an older device the app cannot load the image and shows the notification without it.",
};

const classifyNotificationImage = (head: Buffer): NotificationImageFormat | null => {
  if (detectImageMimeType(head) !== null) {
    return "common";
  }
  const signature = head.toString("latin1", 0, 6);
  if (signature === "GIF87a" || signature === "GIF89a" || signature.startsWith("BM")) {
    return "common";
  }
  if (head.length >= 12 && head.toString("latin1", 4, 8) === "ftyp") {
    const brand = head.toString("latin1", 8, 12);
    if (AVIF_BRANDS.has(brand)) {
      return "avif";
    }
    if (HEIF_BRANDS.has(brand)) {
      return "heif";
    }
  }
  return null;
};

const quoteForShell = (value: string): string => {
  return shellQuote(value.replace(/\r?\n/g, "\\n"));
};

const quoteForAdbArg = (value: string): string => {
  const escaped = value.replace(/\\/g, "\\\\").replace(/\"/g, '\\"');
  return `"${escaped}"`;
};

const AutoMobileNotificationExtras = {
  title: "title",
  body: "body",
  style: "style",
  imagePath: "image_path",
  actions: "actions_json",
  channelId: "channel_id",
};
