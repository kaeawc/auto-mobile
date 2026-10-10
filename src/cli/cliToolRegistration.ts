// Import all tool registration functions
import { installDefaultProvisionedDeviceTransportFence } from "../db/createDefaultProvisionedDeviceTransportFence";
import { registerObserveTools } from "../server/observeTools";
import { registerInteractionTools } from "../server/interactionTools";
import { registerAppTools } from "../server/appTools";
import { registerUtilityTools } from "../server/utilityTools";
import { registerDeviceTools } from "../server/deviceTools";
import { registerPlanTools } from "../server/planTools";
import { registerDoctorTools } from "../server/doctorTools";
import { registerVideoRecordingTools } from "../server/videoRecordingTools";
import { registerNotificationTools } from "../server/notificationTools";
import { registerAccessibilityFocusTools } from "../server/accessibilityFocusTools";
import { registerAccessibilityTools } from "../server/accessibilityTools";
import { registerAppFileTools } from "../server/appFileTools";
import { registerBarrierTools } from "../server/barrierTools";
import { registerBiometricTools } from "../server/biometricTools";
import { registerCriticalSectionTools } from "../server/criticalSectionTools";
import { registerDatabaseTools } from "../server/databaseTools";
import { registerDeepLinkTools } from "../server/deepLinkTools";
import { registerFormTools } from "../server/formTools";
import { registerPrototypeTools } from "../server/prototypeTools";
import { prototypeAgentRegistry } from "../features/prototype/ios/prototypeAgentInjection";
import { registerHighlightTools } from "../server/highlightTools";
import { registerNavigationTools } from "../server/navigationTools";
import { registerNetworkTools } from "../server/networkTools";
import { registerPreferenceTools } from "../server/preferenceTools";
import { registerSnapshotTools } from "../server/snapshotTools";
import { registerSnapshotOfTools } from "../server/snapshotOfTools";
import { registerStorageTools } from "../server/storageTools";
import { registerTelephonyTools } from "../server/telephonyTools";
import { registerSessionLogTools } from "../server/sessionLogTools";
import { registerDownloadsFixtureTools } from "../server/downloadsFixtureTools";

// Initialize tool registry for CLI mode
export function initializeCliTools(): void {
  installDefaultProvisionedDeviceTransportFence();
  // Register all tool categories
  registerObserveTools();
  registerInteractionTools();
  registerAppTools();
  registerUtilityTools();
  registerDeviceTools();
  registerPlanTools();
  registerDoctorTools();
  registerVideoRecordingTools();
  registerNotificationTools();
  registerAccessibilityFocusTools();
  registerAccessibilityTools();
  registerAppFileTools();
  registerBarrierTools();
  registerBiometricTools();
  registerCriticalSectionTools();
  registerDatabaseTools();
  registerDeepLinkTools();
  registerFormTools();
  registerHighlightTools();
  registerPrototypeTools({ agentConnections: prototypeAgentRegistry });
  registerNavigationTools();
  registerNetworkTools();
  registerPreferenceTools();
  registerSnapshotTools();
  registerSnapshotOfTools();
  registerStorageTools();
  registerTelephonyTools();
  registerSessionLogTools();
  registerDownloadsFixtureTools();
}
