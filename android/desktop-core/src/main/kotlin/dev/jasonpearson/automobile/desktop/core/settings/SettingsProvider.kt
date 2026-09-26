package dev.jasonpearson.automobile.desktop.core.settings

/** Interface for accessing AutoMobile settings without coupling to IntelliJ APIs. */
interface SettingsProvider {
  var enableYamlLinting: Boolean
  var testPlanOutputDirectory: String
  var fogModeEnabled: Boolean
  var autoFocusEnabled: Boolean
  var failuresDateRange: String // "1h", "24h", "3d", "7d", "30d"
  /** JSON array of globally saved Logs filter views. */
  var logsSavedViews: String
  /** JSON object mapping device IDs to their minimum enabled Logs level name. */
  var logsMinLevelByDevice: String
  /** IDE to open Android/Kotlin/Java files in. "auto", "android-studio", "intellij", "vscode" */
  var androidIde: String
  /** IDE to open Swift/ObjC files in. "auto", "xcode", "vscode" */
  var iosIde: String
  /** Theme mode: "dark", "light", or "system" */
  var themeMode: String
  /** Whether the first-run onboarding has been dismissed. */
  var hasSeenOnboarding: Boolean
  /** Live-mirror quality preset: "low", "medium", or "high". */
  var streamQualityPreset: String
  /** Whether the live mirror lowers/raises its quality preset automatically on frame drops. */
  var streamQualityAutoAdjust: Boolean
}
