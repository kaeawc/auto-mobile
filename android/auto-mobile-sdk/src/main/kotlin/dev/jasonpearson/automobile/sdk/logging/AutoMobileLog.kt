package dev.jasonpearson.automobile.sdk.logging

import android.util.Log

/**
 * Thin wrapper around [android.util.Log] with filter-based log capture.
 *
 * Delegates all logging to the platform Log API. When one or more [CompiledLogFilter]s are
 * registered, matching entries are also forwarded to the SDK event buffer.
 *
 * Severity-level mapping between platforms:
 * - Android `wtf` (What a Terrible Failure) corresponds to iOS `fault`.
 */
object AutoMobileLog {

  private val lock = Any()
  private val filters = mutableMapOf<String, CompiledLogFilter>()

  /** No-op retained for source compatibility during migration. */
  internal fun initialize() {}

  // --- Filter API ---

  /**
   * Registers a named filter. If a filter with the same name exists it is replaced.
   *
   * @param name Unique filter name used for later removal.
   * @param tagPattern Optional regex applied to the log tag. `null` matches any tag.
   * @param messagePattern Optional regex applied to the log message. `null` matches any message.
   * @param minLevel Minimum [android.util.Log] priority (default [Log.VERBOSE]).
   */
  fun addFilter(
    name: String,
    tagPattern: Regex? = null,
    messagePattern: Regex? = null,
    minLevel: Int = Log.VERBOSE,
  ) {
    val filter = CompiledLogFilter(name, tagPattern, messagePattern, minLevel)
    synchronized(lock) { filters[name] = filter }
  }

  /** Removes the filter with the given [name]. No-op if the name is not registered. */
  fun removeFilter(name: String) {
    synchronized(lock) { filters.remove(name) }
  }

  /** Removes all registered filters. */
  fun clearFilters() {
    synchronized(lock) { filters.clear() }
  }

  // --- Log Methods ---

  fun v(tag: String, msg: String): Int = Log.v(tag, msg)

  fun v(tag: String, msg: String, tr: Throwable): Int = Log.v(tag, msg, tr)

  fun d(tag: String, msg: String): Int = Log.d(tag, msg)

  fun d(tag: String, msg: String, tr: Throwable): Int = Log.d(tag, msg, tr)

  fun i(tag: String, msg: String): Int = Log.i(tag, msg)

  fun i(tag: String, msg: String, tr: Throwable): Int = Log.i(tag, msg, tr)

  fun w(tag: String, msg: String): Int = Log.w(tag, msg)

  fun w(tag: String, msg: String, tr: Throwable): Int = Log.w(tag, msg, tr)

  fun e(tag: String, msg: String): Int = Log.e(tag, msg)

  fun e(tag: String, msg: String, tr: Throwable): Int = Log.e(tag, msg, tr)

  fun wtf(tag: String, msg: String): Int {
    Log.wtf(tag, msg)
    return 0
  }

  fun wtf(tag: String, msg: String, tr: Throwable): Int {
    Log.wtf(tag, msg, tr)
    return 0
  }
}
