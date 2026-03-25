package dev.jasonpearson.automobile.shared.settings

/** Interface for accessing AutoMobile settings without coupling to IntelliJ APIs. */
interface SettingsProvider {
  var enableYamlLinting: Boolean
  var testPlanOutputDirectory: String
  var fogModeEnabled: Boolean
  var autoFocusEnabled: Boolean
  var failuresDateRange: String // "1h", "24h", "3d", "7d", "30d"
}
