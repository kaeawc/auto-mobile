import { PLAN_RELEVANT } from "./toolRegistryTypes";
import { ToolRegistry } from "./toolRegistry";
import { resetAppLogsSchema, type ResetAppLogsArgs } from "./sessionLogContract";
import { getSessionLogService, type SessionLogService } from "./sessionLogService";
import { createStructuredToolResponse } from "../utils/toolUtils";
import { resetAppLogsResultSchema } from "./sessionLogToolOutputSchemas";
import type { BootedDevice } from "../models";

export function registerSessionLogTools(
  service: () => SessionLogService = getSessionLogService,
): void {
  ToolRegistry.registerDeviceAware(
    "resetAppLogs",
    "Reset explicitly named app-container log files (and their rotated `<path>.N` siblings) " +
      "on the session's device, reporting a per-path outcome.",
    resetAppLogsSchema,
    async (device: BootedDevice, args: ResetAppLogsArgs, _progress, signal) => {
      const result = await service().resetAppLogs({
        device,
        appId: args.appId,
        container: args.container ?? "documents",
        paths: args.paths,
        signal,
      });
      return createStructuredToolResponse(result);
    },
    { ...PLAN_RELEVANT, defaultEnabled: false, outputSchema: resetAppLogsResultSchema },
  );
}
