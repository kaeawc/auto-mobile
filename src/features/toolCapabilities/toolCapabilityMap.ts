import type { ToolCapability } from "./SessionToolProfileService";

const groups: Record<ToolCapability, readonly string[]> = {
  "clipboard": ["clipboard", "selectAllText"],
  "advanced-interaction": ["openLink", "imeAction", "dragAndDrop", "pinchOn", "shake", "rotate"],
  "app-permissions": ["getAppPermissions", "setAppPermissions"],
  "device-settings": ["changeLocalization", "getDeviceState", "setDeviceState"],
  "device-control": ["provisionDevice"],
  "app-data-interop": ["putAppFile", "getPreference", "setPreference", "sqlQuery", "setKeyValue", "removeKeyValue", "clearKeyValueFile"],
  "notifications": ["systemTray", "postNotification", "getNotificationPolicy", "setNotificationPolicy"],
  "telephony": ["phoneCall", "sendSms"],
  "accessibility-tools": ["accessibility", "accessibilityFocus"],
  "screen-artifacts": ["videoRecording", "deviceSnapshot", "highlight"],
  "test-authoring": ["executePlan", "startTestRecording", "exportPlan", "recordSteps", "barrier", "criticalSection"],
  "network-inspection": ["network", "mockNetwork", "clearMockNetwork", "getNetworkGraph"],
  "app-routing": ["getDeepLinks"],
  "navigation-modeling": ["navigateTo", "getNavigationGraph", "explore"],
  "biometric-auth": ["biometricAuth"],
};

export const TOOL_CAPABILITY_BY_NAME = new Map<string, ToolCapability>(
  Object.entries(groups).flatMap(([capability, tools]) => tools.map(tool => [tool, capability as ToolCapability]))
);
