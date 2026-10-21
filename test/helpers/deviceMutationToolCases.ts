export const DEVICE_MUTATION_TOOL_CASES: readonly {
  name: string;
  args: Record<string, unknown>;
  kind: string;
}[] = [
  {
    name: "installApp",
    args: { artifactPath: "/app.apk", appId: "com.example" },
    kind: "installed-app",
  },
  { name: "uninstallApp", args: { appId: "com.example" }, kind: "installed-app" },
  {
    name: "setAppPermissions",
    args: { appId: "com.example", permissions: ["camera"] },
    kind: "permission",
  },
  { name: "clipboard", args: { action: "copy", text: "new" }, kind: "clipboard" },
  { name: "displayConfig", args: { theme: "dark" }, kind: "device-setting" },
  { name: "changeLocalization", args: { locale: "ja-JP" }, kind: "device-setting" },
  { name: "setDeviceState", args: { location: { latitude: 1, longitude: 2 } }, kind: "location" },
  { name: "biometricAuth", args: { action: "enroll" }, kind: "biometric-enrollment" },
  { name: "network", args: { simulateErrors: { durationSeconds: 5 } }, kind: "network-condition" },
  {
    name: "putAppFile",
    args: {
      target: { domain: "app_containers", appId: "com.example", container: "documents" },
      files: [{ destinationPath: "a.txt", contentText: "new" }],
    },
    kind: "shared-file",
  },
  { name: "openLink", args: { url: "https://example.com" }, kind: "opened-url" },
  {
    name: "setUIState",
    args: { fields: [{ selector: { text: "Name" }, value: "new" }] },
    kind: "preference",
  },
  { name: "accessibility", args: { talkback: true }, kind: "screen-reader" },
  { name: "keyboard", args: { action: "hide" }, kind: "keyboard" },
  { name: "postNotification", args: { title: "New" }, kind: "notification" },
  { name: "resetKeychain", args: {}, kind: "keychain" },
  { name: "rotate", args: { orientation: "landscape" }, kind: "rotation" },
  {
    name: "windowMode",
    args: { appId: "com.example", mode: "fullscreen" },
    kind: "device-setting",
  },
  { name: "setNotificationPolicy", args: {}, kind: "notification" },
  { name: "setPosture", args: { posture: "folded" }, kind: "device-setting" },
  { name: "accessibilityAction", args: {}, kind: "opaque" },
  { name: "displayProfile", args: {}, kind: "opaque" },
  { name: "killProfile", args: {}, kind: "opaque" },
  { name: "mediaSession", args: {}, kind: "opaque" },
  { name: "setAppLinks", args: {}, kind: "opaque" },
  { name: "setSensor", args: {}, kind: "opaque" },
  {
    name: "setKeyValue",
    args: { appId: "com.example", name: "settings", key: "enabled", value: true, type: "BOOLEAN" },
    kind: "preference",
  },
  {
    name: "removeKeyValue",
    args: { appId: "com.example", name: "settings", key: "enabled" },
    kind: "preference",
  },
  {
    name: "clearKeyValueFile",
    args: { appId: "com.example", name: "settings" },
    kind: "preference",
  },
  {
    name: "setPreference",
    args: { scope: "systemProperty", key: "debug.example", value: "1", type: "string" },
    kind: "preference",
  },
  {
    name: "sqlQuery",
    args: { appId: "com.example", databasePath: "db.sqlite", query: "DELETE FROM items" },
    kind: "opaque",
  },
  { name: "mockNetwork", args: { host: "example.com", path: "/api" }, kind: "opaque" },
  { name: "clearMockNetwork", args: {}, kind: "opaque" },
  { name: "phoneCall", args: { action: "call", phoneNumber: "123" }, kind: "opaque" },
  { name: "sendSms", args: { phoneNumber: "123", message: "Hello" }, kind: "opaque" },
  { name: "resetAppLogs", args: { appId: "com.example", paths: ["app.log"] }, kind: "opaque" },
  { name: "deviceSnapshot", args: { action: "restore", snapshotName: "baseline" }, kind: "opaque" },
];
