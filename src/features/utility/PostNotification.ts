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
import { isIosSimulatorUdid } from "../../utils/ios-cmdline-tools/iosDeviceType";
import { fileURLToPath } from "url";
import fs from "fs/promises";
import path from "path";
import { shellQuote } from "../../utils/shellQuote";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../utils/workingDirectory";

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
const SDK_RESULT_SUCCESS = 1;
const DEVICE_IMAGE_DIR = "/sdcard/Download/automobile";
export const ANDROID_PACKAGE_NAME_PATTERN = /^[A-Za-z][A-Za-z0-9_]*(?:\.[A-Za-z][A-Za-z0-9_]*)+$/;

export class PostNotification {
  private device: BootedDevice;
  private adb: AdbExecutor;
  private adbFactory: AdbClientFactory;
  private window: WindowInterface;
  private simctl: SimCtlClient;

  constructor(
    device: BootedDevice,
    adbFactoryOrExecutor: AdbClientFactory | AdbExecutor | null = defaultAdbClientFactory,
    window: WindowInterface | null = null,
    simctl: SimCtlClient | null = null,
  ) {
    this.device = device;
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

    // simctl push is simulator-only. Use the repo's UDID-shape convention (NOT device.source).
    if (!isIosSimulatorUdid(this.device.deviceId)) {
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
        error: result.error ?? "simctl push failed.",
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

      let imagePath = options.imagePath;
      if (imageType === "bigPicture") {
        if (!imagePath) {
          return {
            success: false,
            supported: false,
            imageType,
            error: "imagePath is required for bigPicture imageType notifications.",
          };
        }

        const prepared = await this.prepareDeviceImagePath(imagePath, signal);
        if (!prepared.success) {
          return {
            success: false,
            supported: false,
            imageType,
            error: prepared.error,
          };
        }
        imagePath = prepared.devicePath;
      }

      const sdkResult = await this.trySdkPost(
        {
          ...options,
          imagePath,
        },
        imageType,
        signal,
      );
      return sdkResult;
    } catch (error) {
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

      const resultCode = this.parseBroadcastResultCode(output);
      if (resultCode === SDK_RESULT_SUCCESS) {
        return {
          success: true,
          supported: true,
          method: "sdk",
          imageType,
          appId,
          channelId: options.channelId,
        };
      }

      return {
        success: false,
        supported: true,
        method: "sdk",
        imageType,
        appId,
        channelId: options.channelId,
        error:
          resultCode === null
            ? "SDK notification broadcast did not return a result code."
            : "SDK notification receiver reported a failure.",
      };
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

  private isReceiverUnavailable(output: string): boolean {
    const lower = output.toLowerCase();
    return (
      lower.includes("no receiver") ||
      lower.includes("no receivers") ||
      lower.includes("not found") ||
      lower.includes("does not exist") ||
      lower.includes("securityexception")
    );
  }

  private async prepareDeviceImagePath(
    imagePath: string,
    signal?: AbortSignal,
  ): Promise<{ success: true; devicePath: string } | { success: false; error: string }> {
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

    let stats;
    try {
      stats = await fs.stat(sourcePath);
    } catch (error) {
      return {
        success: false,
        error: `Image file not found at ${sourcePath}`,
      };
    }

    if (!stats.isFile()) {
      return {
        success: false,
        error: `Image path is not a file: ${sourcePath}`,
      };
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
        undefined,
        undefined,
        true,
        signal,
      );
      return { success: true, devicePath };
    } catch (error) {
      return {
        success: false,
        error: `Failed to push image to device: ${errorMessage(error)}`,
      };
    }
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
