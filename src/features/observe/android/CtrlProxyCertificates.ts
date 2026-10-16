/**
 * CtrlProxyCertificates - Delegate for CA certificate and permission operations.
 *
 * This delegate handles CA certificate installation/removal (device owner only),
 * device owner status queries, and permission requests.
 */

import { rethrowRealCtrlProxyWebSocketInTestError } from "../DeviceServiceClient";
import { errorMessage } from "../../../utils/describeUnknownError";
import fs from "fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { shellQuote } from "../../../utils/shellQuote";
import { logger } from "../../../utils/logger";
import type { PerformanceTracker } from "../../../utils/PerformanceTracker";
import { NoOpPerformanceTracker } from "../../../utils/PerformanceTracker";
import { resolvePathFromDaemonLaunchWorkingDirectory } from "../../../utils/workingDirectory";
import type {
  CertificatesDelegateContext,
  A11yCaCertResult,
  A11yDeviceOwnerStatusResult,
  A11yPermissionResult,
} from "./types";
import { quoteForAdbArg } from "./types";
import { createTimestampedId } from "../../../utils/IdGenerator";
import { sendCommand } from "../DeviceServiceUtils";

/** Directory on device for pushing certificate files */
const DEVICE_CERT_DIR = "/sdcard/Download/automobile/ca_certs";
// Bound best-effort cleanup independently of the certificate installation timeout.
const DEVICE_CERT_CLEANUP_TIMEOUT_MS = 1500;

export interface CertificateFileSystem {
  stat(filePath: string): Promise<{ size: number; isFile(): boolean }>;
}

const nodeCertificateFileSystem: CertificateFileSystem = {
  stat: (filePath) => fs.stat(filePath),
};

/**
 * Delegate class for handling CA certificate and permission operations.
 */
export class CtrlProxyCertificates {
  private readonly context: CertificatesDelegateContext;
  private readonly fileSystem: CertificateFileSystem;

  constructor(
    context: CertificatesDelegateContext,
    fileSystem: CertificateFileSystem = nodeCertificateFileSystem,
  ) {
    this.context = context;
    this.fileSystem = fileSystem;
  }

  /**
   * Request installation of a CA certificate via the accessibility service.
   * The certificate payload can be PEM or base64-encoded DER.
   */
  async requestInstallCaCertificate(
    certificate: string,
    timeoutMs: number = 10000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<A11yCaCertResult> {
    const startTime = this.context.timer.now();
    const failure = (error: string): A11yCaCertResult => ({
      success: false,
      action: "install",
      totalTimeMs: this.context.timer.now() - startTime,
      error,
    });
    const trimmed = certificate.trim();

    if (!trimmed) {
      return {
        success: false,
        action: "install",
        totalTimeMs: this.context.timer.now() - startTime,
        error: "Certificate payload is required",
      };
    }

    try {
      const result = await this.sendCertificateCommand<A11yCaCertResult>({
        idPrefix: "caCertInstall",
        messageType: "install_ca_cert",
        params: { certificate: trimmed },
        timeoutMs,
        perf,
        notConnectedLog:
          "[CTRL_PROXY] Failed to establish WebSocket connection for CA cert install",
        timeoutLabel: "CA cert install",
        failure,
      });
      const clientDuration = this.context.timer.now() - startTime;

      if (result.success) {
        logger.info(
          `[CTRL_PROXY] CA cert install completed: clientTime=${clientDuration}ms, deviceTotalTime=${result.totalTimeMs}ms, alias=${result.alias ?? "unknown"}`,
        );
      } else {
        logger.warn(
          `[CTRL_PROXY] CA cert install failed after ${clientDuration}ms: ${result.error}`,
        );
      }

      return result;
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] CA cert install request failed after ${duration}ms: ${error}`);
      return {
        success: false,
        action: "install",
        totalTimeMs: duration,
        error: `${error}`,
      };
    }
  }

  /**
   * Shared sendCommand wrapper for the certificate and permission requests. Auto-connects like
   * the hand-rolled paths did, attaches no ambient abort (so removal and cleanup requests stay
   * uncancellable), and bypasses the generic command gate.
   */
  private sendCertificateCommand<T>(request: {
    idPrefix: string;
    messageType: string;
    params: Record<string, unknown>;
    timeoutMs: number;
    perf: PerformanceTracker;
    notConnectedLog: string;
    timeoutLabel: string;
    failure: (error: string) => T;
  }): Promise<T> {
    const { failure } = request;
    return sendCommand<T>(
      { ...this.context, isCommandSupported: undefined, wireDeadlineParams: undefined },
      {
        idPrefix: request.idPrefix,
        responseType: request.idPrefix,
        messageType: request.messageType,
        params: request.params,
        timeoutMs: request.timeoutMs,
        perf: request.perf,
        cancelScreenshotBackoff: false,
        notConnectedError: () => {
          logger.warn(request.notConnectedLog);
          return failure("Failed to connect to accessibility service");
        },
        timeoutError: (timeout) => failure(`${request.timeoutLabel} timeout after ${timeout}ms`),
        unsupportedCommandError: (_messageType, error) => failure(error),
      },
    );
  }

  /**
   * Request installation of a CA certificate from a host file path.
   * Pushes the file to the device before requesting installation.
   */
  async requestInstallCaCertificateFromFile(
    certificatePath: string,
    timeoutMs: number = 10000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<A11yCaCertResult> {
    const startTime = this.context.timer.now();
    const failure = (error: string): A11yCaCertResult => ({
      success: false,
      action: "install",
      totalTimeMs: this.context.timer.now() - startTime,
      error,
    });
    const resolvedPath = this.resolveCertificatePath(certificatePath);

    if (!resolvedPath) {
      return {
        success: false,
        action: "install",
        totalTimeMs: this.context.timer.now() - startTime,
        error: "certificatePath must be a valid host file path",
      };
    }

    let devicePath: string | undefined;
    try {
      const stats = await this.fileSystem.stat(resolvedPath);
      if (!stats.isFile()) {
        return {
          success: false,
          action: "install",
          totalTimeMs: this.context.timer.now() - startTime,
          error: `Certificate path is not a file: ${resolvedPath}`,
        };
      }

      if (stats.size === 0) {
        return {
          success: false,
          action: "install",
          totalTimeMs: this.context.timer.now() - startTime,
          error: `Certificate file is empty: ${resolvedPath}`,
        };
      }

      const pushedDevicePath = await perf.track("pushCertificate", async () => {
        return this.pushCertificateToDevice(resolvedPath);
      });
      devicePath = pushedDevicePath;

      const result = await this.sendCertificateCommand<A11yCaCertResult>({
        idPrefix: "caCertInstallFromPath",
        messageType: "install_ca_cert_from_path",
        params: { devicePath: pushedDevicePath },
        timeoutMs,
        perf,
        notConnectedLog:
          "[CTRL_PROXY] Failed to establish WebSocket connection for CA cert install",
        timeoutLabel: "CA cert install",
        failure,
      });
      const clientDuration = this.context.timer.now() - startTime;

      if (result.success) {
        logger.info(
          `[CTRL_PROXY] CA cert install completed: clientTime=${clientDuration}ms, deviceTotalTime=${result.totalTimeMs}ms, alias=${result.alias ?? "unknown"}`,
        );
      } else {
        logger.warn(
          `[CTRL_PROXY] CA cert install failed after ${clientDuration}ms: ${result.error}`,
        );
      }

      return result;
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      logger.warn("[CTRL_PROXY] CA cert file install request failed", error);
      return {
        success: false,
        action: "install",
        totalTimeMs: this.context.timer.now() - startTime,
        error: errorMessage(error),
      };
    } finally {
      if (devicePath !== undefined) {
        // Do not await: cleanup must not delay the install result or cancellation.
        this.removeDeviceCertificate(devicePath).catch((error: unknown) => {
          // Best-effort removal from the temporary cert directory must not replace the install result.
          logger.debug("[CTRL_PROXY] Could not remove temporary certificate file", error);
        });
      }
    }
  }

  /**
   * Request removal of a CA certificate via the accessibility service.
   * Uses the alias returned from installation.
   */
  async requestRemoveCaCertificate(
    alias: string,
    timeoutMs: number = 10000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<A11yCaCertResult> {
    const startTime = this.context.timer.now();
    const failure = (error: string): A11yCaCertResult => ({
      success: false,
      action: "remove",
      totalTimeMs: this.context.timer.now() - startTime,
      error,
    });
    const trimmedAlias = alias.trim();

    if (!trimmedAlias) {
      return {
        success: false,
        action: "remove",
        totalTimeMs: this.context.timer.now() - startTime,
        error: "Certificate alias is required",
      };
    }

    try {
      const result = await this.sendCertificateCommand<A11yCaCertResult>({
        idPrefix: "caCertRemove",
        messageType: "remove_ca_cert",
        params: { alias: trimmedAlias },
        timeoutMs,
        perf,
        notConnectedLog:
          "[CTRL_PROXY] Failed to establish WebSocket connection for CA cert removal",
        timeoutLabel: "CA cert removal",
        failure,
      });
      const clientDuration = this.context.timer.now() - startTime;

      if (result.success) {
        logger.info(
          `[CTRL_PROXY] CA cert removal completed: clientTime=${clientDuration}ms, deviceTotalTime=${result.totalTimeMs}ms, alias=${result.alias ?? trimmedAlias}`,
        );
      } else {
        logger.warn(
          `[CTRL_PROXY] CA cert removal failed after ${clientDuration}ms: ${result.error}`,
        );
      }

      return result;
    } catch (error) {
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] CA cert removal request failed after ${duration}ms: ${error}`);
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      return {
        success: false,
        action: "remove",
        totalTimeMs: duration,
        error: `${error}`,
      };
    }
  }

  /**
   * Request device owner status via the accessibility service.
   */
  async requestDeviceOwnerStatus(
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<A11yDeviceOwnerStatusResult> {
    const startTime = this.context.timer.now();
    const failure = (error: string): A11yDeviceOwnerStatusResult => ({
      success: false,
      isDeviceOwner: false,
      isAdminActive: false,
      totalTimeMs: this.context.timer.now() - startTime,
      error,
    });

    try {
      const result = await this.sendCertificateCommand<A11yDeviceOwnerStatusResult>({
        idPrefix: "deviceOwnerStatus",
        messageType: "get_device_owner_status",
        params: {},
        timeoutMs,
        perf,
        notConnectedLog:
          "[CTRL_PROXY] Failed to establish WebSocket connection for device owner status",
        timeoutLabel: "Device owner status",
        failure,
      });
      const clientDuration = this.context.timer.now() - startTime;

      if (result.success) {
        logger.info(
          `[CTRL_PROXY] Device owner status received: clientTime=${clientDuration}ms, deviceTotalTime=${result.totalTimeMs}ms, owner=${result.isDeviceOwner}, admin=${result.isAdminActive}`,
        );
      } else {
        logger.warn(
          `[CTRL_PROXY] Device owner status failed after ${clientDuration}ms: ${result.error}`,
        );
      }

      return result;
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Device owner status request failed after ${duration}ms: ${error}`);
      return {
        success: false,
        isDeviceOwner: false,
        isAdminActive: false,
        totalTimeMs: duration,
        error: `${error}`,
      };
    }
  }

  /**
   * Request permission status via the accessibility service.
   */
  async requestPermission(
    permission: string,
    requestPermission: boolean = true,
    timeoutMs: number = 5000,
    perf: PerformanceTracker = new NoOpPerformanceTracker(),
  ): Promise<A11yPermissionResult> {
    const startTime = this.context.timer.now();
    const trimmedPermission = permission.trim();
    const failure = (error: string): A11yPermissionResult => ({
      success: false,
      permission: trimmedPermission,
      granted: false,
      totalTimeMs: this.context.timer.now() - startTime,
      requestLaunched: false,
      canRequest: false,
      requiresSettings: false,
      error,
    });

    if (!trimmedPermission) {
      return {
        success: false,
        permission: "unknown",
        granted: false,
        totalTimeMs: this.context.timer.now() - startTime,
        requestLaunched: false,
        canRequest: false,
        requiresSettings: false,
        error: "Permission name is required",
      };
    }

    try {
      const result = await this.sendCertificateCommand<A11yPermissionResult>({
        idPrefix: "permission",
        messageType: "get_permission",
        params: { permission: trimmedPermission, requestPermission },
        timeoutMs,
        perf,
        notConnectedLog:
          "[CTRL_PROXY] Failed to establish WebSocket connection for permission request",
        timeoutLabel: "Permission request",
        failure,
      });
      const clientDuration = this.context.timer.now() - startTime;

      if (result.success) {
        logger.info(
          `[CTRL_PROXY] Permission status received: clientTime=${clientDuration}ms, deviceTotalTime=${result.totalTimeMs}ms, permission=${result.permission}, granted=${result.granted}`,
        );
      } else {
        logger.warn(
          `[CTRL_PROXY] Permission request failed after ${clientDuration}ms: ${result.error}`,
        );
      }

      return result;
    } catch (error) {
      // A unit test reached the real WebSocket factory; fail it, never resolve a typed failure.
      rethrowRealCtrlProxyWebSocketInTestError(error);
      const duration = this.context.timer.now() - startTime;
      logger.warn(`[CTRL_PROXY] Permission request failed after ${duration}ms: ${error}`);
      return {
        success: false,
        permission: trimmedPermission,
        granted: false,
        totalTimeMs: duration,
        requestLaunched: false,
        canRequest: false,
        requiresSettings: false,
        error: `${error}`,
      };
    }
  }

  /**
   * Handle CA cert removal result from WebSocket message.
   * This is called by the main client when a ca_cert_result with remove action is received.
   */
  handleCaCertRemovalResult(requestId: string, result: A11yCaCertResult): boolean {
    return this.context.requestManager.resolve<A11yCaCertResult>(requestId, result);
  }

  /**
   * Resolve a certificate path from various formats to an absolute host path.
   */
  private resolveCertificatePath(certificatePath: string): string | null {
    const trimmedPath = certificatePath.trim();
    if (!trimmedPath) {
      return null;
    }

    if (trimmedPath.startsWith("file://")) {
      try {
        return fileURLToPath(trimmedPath);
      } catch (error) {
        logger.warn(`[CTRL_PROXY] Failed to parse certificate file URL: ${error}`);
        return null;
      }
    }

    if (trimmedPath.startsWith("content://") || trimmedPath.startsWith("/sdcard")) {
      return null;
    }

    return resolvePathFromDaemonLaunchWorkingDirectory(trimmedPath);
  }

  /**
   * Push a certificate file to the device.
   */
  private async pushCertificateToDevice(sourcePath: string): Promise<string> {
    await this.context.adb.executeCommand(
      `shell mkdir -p ${DEVICE_CERT_DIR}`,
      undefined,
      undefined,
      true,
    );

    const devicePath = this.buildDeviceCertificatePath(sourcePath);
    await this.context.adb.executeCommand(
      `push ${quoteForAdbArg(sourcePath)} ${quoteForAdbArg(devicePath)}`,
      undefined,
      undefined,
      true,
    );

    return devicePath;
  }

  private async removeDeviceCertificate(devicePath: string): Promise<void> {
    await this.context.adb.executeCommand(
      `shell rm -f ${shellQuote(devicePath)}`,
      DEVICE_CERT_CLEANUP_TIMEOUT_MS,
      undefined,
      true,
      // Override ADB's ambient request signal so cancellation still permits bounded cleanup.
      new AbortController().signal,
    );
  }

  /**
   * Build a unique device path for a certificate file.
   */
  private buildDeviceCertificatePath(sourcePath: string): string {
    const ext = path.extname(sourcePath) || ".crt";
    const base = path.basename(sourcePath, ext);
    const fileName = `${createTimestampedId(base, this.context.timer, this.context.idGenerator)}${ext}`;
    return `${DEVICE_CERT_DIR}/${fileName}`;
  }
}
