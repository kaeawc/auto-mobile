import { registerObserveTools } from "./observeTools";
import { registerInteractionTools } from "./interactionTools";
import { registerAppTools } from "./appTools";
import { registerUtilityTools } from "./utilityTools";
import { registerDeviceTools } from "./deviceTools";
import { registerDeepLinkTools } from "./deepLinkTools";
import { registerNavigationTools } from "./navigationTools";
import { registerNotificationTools } from "./notificationTools";
import { registerPlanTools } from "./planTools";
import { registerDoctorTools } from "./doctorTools";
import { registerCriticalSectionTools } from "./criticalSectionTools";
import { registerBarrierTools } from "./barrierTools";
import { registerVideoRecordingTools } from "./videoRecordingTools";
import { registerSnapshotTools } from "./snapshotTools";
import { registerSnapshotOfTools } from "./snapshotOfTools";
import { registerBiometricTools } from "./biometricTools";
import { registerTelephonyTools } from "./telephonyTools";
import { registerPrototypeTools } from "./prototypeTools";
import { prototypeAgentRegistry } from "../features/prototype/ios/prototypeAgentInjection";
import {
  CompositePrototypeAgentConnections,
  prototypeViewerConnections,
} from "../features/prototype/ios/prototypeViewerAttach";
import { registerHighlightTools } from "./highlightTools";
import { registerDatabaseTools } from "./databaseTools";
import { registerStorageTools } from "./storageTools";
import { registerPreferenceTools } from "./preferenceTools";
import { registerAppFileTools } from "./appFileTools";
import { registerSessionLogTools } from "./sessionLogTools";
import { registerDownloadsFixtureTools } from "./downloadsFixtureTools";
import { registerFormTools } from "./formTools";
import { registerAccessibilityTools } from "./accessibilityTools";
import { registerAccessibilityFocusTools } from "./accessibilityFocusTools";
import { registerNetworkTools } from "./networkTools";
import { registerToolSelectionTools } from "./toolSelectionTools";

export interface RegisterAllToolsOptions {
  /**
   * Register the daemon-only coordination tools (critical section, barrier), which need the
   * daemon's lock manager. The stdio server leaves them out; the CLI, the generators and the
   * measurement scripts include them.
   */
  daemonMode: boolean;
  /** Register the `doctor` tool (CLI and the measurement scripts). */
  includeDoctor?: boolean;
  /** Register the session tool-selection tools. The CLI has no session to select for. Default true. */
  includeToolSelection?: boolean;
}

/**
 * The one list of tool groups every entry point registers (server, CLI, tool-definition
 * generator, benchmark and context estimator). Registration order is the order `tools/list`
 * advertises, so keep it stable. Registration is idempotent: the registry is keyed by name.
 */
export function registerAllTools(options: RegisterAllToolsOptions): void {
  registerObserveTools();
  registerInteractionTools();
  registerAppTools();
  registerUtilityTools();
  registerDeviceTools();
  registerDeepLinkTools();
  registerNavigationTools();
  registerNotificationTools();
  // Plan tools (executePlan, recordToolCalls, recordDeviceGestures, exportPlan)
  // are registered outside the daemonMode gate so tool call recording works in stdio mode
  // (the standard MCP transport agents use). executePlan multi-device allocation
  // still requires daemon and throws a clear error without it.
  // Critical section tools remain daemon-only (DaemonState lock manager).
  registerPlanTools();
  if (options.includeDoctor) {
    registerDoctorTools();
  }
  if (options.daemonMode) {
    registerCriticalSectionTools();
    registerBarrierTools();
  }
  registerVideoRecordingTools();
  registerSnapshotTools();
  registerSnapshotOfTools();
  registerBiometricTools();
  registerTelephonyTools();
  registerHighlightTools();
  registerPrototypeTools({
    agentConnections: new CompositePrototypeAgentConnections(
      prototypeViewerConnections,
      prototypeAgentRegistry,
    ),
  });
  registerDatabaseTools();
  registerStorageTools();
  registerPreferenceTools();
  registerAppFileTools();
  registerSessionLogTools();
  registerDownloadsFixtureTools();
  registerFormTools();
  registerAccessibilityTools();
  registerAccessibilityFocusTools();
  registerNetworkTools();
  if (options.includeToolSelection ?? true) {
    registerToolSelectionTools();
  }
}
