package dev.jasonpearson.automobile.sdk.logging

/**
 * A named log filter with optional regex patterns for tag and message, plus a minimum log level.
 *
 * Severity-level mapping between platforms:
 * - Android `wtf` (What a Terrible Failure) corresponds to iOS `fault`.
 *
 * @property name Unique filter name used for later removal via [AutoMobileLog.removeFilter].
 * @property tagPattern Optional regex applied to the log tag. `null` matches any tag.
 * @property messagePattern Optional regex applied to the log message. `null` matches any message.
 * @property minLevel Minimum [android.util.Log] priority required for a match (default
 *   [android.util.Log.VERBOSE]).
 */
data class CompiledLogFilter(
  val name: String,
  val tagPattern: Regex? = null,
  val messagePattern: Regex? = null,
  val minLevel: Int = android.util.Log.VERBOSE,
) {
  /** Returns `true` when the given [tag], [message], and [level] satisfy this filter. */
  fun matches(tag: String, message: String, level: Int): Boolean {
    if (level < minLevel) return false
    if (tagPattern != null && !tagPattern.containsMatchIn(tag)) return false
    if (messagePattern != null && !messagePattern.containsMatchIn(message)) return false
    return true
  }
}
