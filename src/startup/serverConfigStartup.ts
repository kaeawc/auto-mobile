import { resolveActionsCompactMetadata } from "../utils/outputReductionFlags";
import type { ServerModules } from "./serverModules";
import type { ParsedArgs } from "./startupContext";

/** Seeds the process-wide server configuration from the parsed command line. */
export function applyServerConfigFromArgs(args: ParsedArgs, modules: ServerModules): void {
  const { serverConfig, logger, LogLevel } = modules;
  if (args.debug) {
    logger.setLogLevel(LogLevel.DEBUG);
  }

  serverConfig.setPlanExecutionLockScope(args.planExecutionLockScope);
  if (args.runnerReadinessTimeoutMs !== undefined) {
    serverConfig.setRunnerReadinessTimeoutMs(args.runnerReadinessTimeoutMs);
  }
  serverConfig.setActionsCompactMetadataEnabled(
    resolveActionsCompactMetadata(
      args.outputReduction.actionsCompactMetadata,
      serverConfig.isActionsCompactMetadataEnabled(),
    ),
  );
  serverConfig.setVideoRecordingDefaults(args.videoRecordingDefaults);
  serverConfig.setToolOutputsDir(args.toolOutputsDir);
  serverConfig.setSkipCtrlProxyDownload(args.skipCtrlProxyDownload);
  serverConfig.setEmbeddedSdkEnabled(args.embeddedSdk);
  serverConfig.setNetworkMockableEnabled(args.networkMockable);
  serverConfig.setDismissKeyboardAfterInputEnabled(args.dismissKeyboardAfterInput);
  serverConfig.setEventAllMarkers(args.eventAllMarkers);
}
