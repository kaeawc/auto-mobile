import { DUMPSYS_MAX_BUFFER } from "../../utils/android-cmdline-tools/dumpsysLimits";
import { ActionableError, BootedDevice } from "../../models";
import { serverConfig } from "../../utils/ServerConfig";
import { MemoryAudit } from "../../features/memory/MemoryAudit";
import { defaultAdbClientFactory } from "../../utils/android-cmdline-tools/AdbClientFactory";
import { createGlobalPerformanceTracker } from "../../utils/PerformanceTracker";
import { logger, type Logger } from "../../utils/logger";
import type { ProgressCallback, DeviceAwareToolHandler } from "../toolRegistry";

export interface AuditRunnerInput {
  name: string;
  args: any;
  device: BootedDevice;
  handler: DeviceAwareToolHandler;
  progress?: ProgressCallback;
  signal?: AbortSignal;
}

export interface AuditRunner {
  run(input: AuditRunnerInput): Promise<any>;
}

// Exported for focused unit coverage (issue #3208). Production wires this via
// the ToolRegistry constructor; tests instantiate it directly to exercise the
// memory-audit wrapping decision and foreground-package lookup without a device.
export class DefaultAuditRunner implements AuditRunner {
  constructor(private readonly log: Logger = logger) {}
  async run(input: AuditRunnerInput): Promise<any> {
    const { name, args, device, handler, progress, signal } = input;
    if (!serverConfig.isMemPerfAuditEnabled() || device.platform !== "android") {
      return handler(device, args, progress, signal);
    }

    const packageName = await this.getForegroundPackageName(device);
    if (!packageName) {
      this.log.warn(
        `[ToolRegistry] Could not determine foreground app, skipping memory audit for ${name}`,
      );
      return handler(device, args, progress, signal);
    }

    logger.info(`[ToolRegistry] Running memory audit for ${packageName} during ${name}`);
    const memoryAudit = new MemoryAudit(device);
    const perf = createGlobalPerformanceTracker();
    let response: any | undefined;

    const auditResult = await memoryAudit.runAudit(
      packageName,
      name,
      args,
      async () => {
        response = await handler(device, args, progress, signal);
      },
      perf,
    );

    if (!auditResult.passed) {
      const errorMsg = `Memory audit FAILED for ${packageName} during ${name}\n\n${auditResult.diagnostics}`;
      logger.error(`[ToolRegistry] ${errorMsg}`);
      throw new ActionableError(errorMsg);
    }

    logger.info(`[ToolRegistry] Memory audit PASSED for ${packageName} during ${name}`);
    return response;
  }

  private async getForegroundPackageName(device: BootedDevice): Promise<string | null> {
    try {
      const adb = defaultAdbClientFactory.create(device);
      const { stdout } = await adb.executeCommand("shell dumpsys window | grep mCurrentFocus", {
        maxBuffer: DUMPSYS_MAX_BUFFER,
      });

      const match = stdout.match(/\s+(\S+)\/\S+\}/);
      return match ? match[1] : null;
    } catch (error) {
      this.log.warn(`[ToolRegistry] Failed to get foreground package name: ${error}`);
      return null;
    }
  }
}
