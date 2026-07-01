package dev.jasonpearson.automobile.sdk.logging

/**
 * Test fake that records every log call for assertion.
 *
 * Each entry is stored as a [LogEntry] with the level, tag, evaluated message, and optional
 * throwable.
 */
internal class FakeSdkLogger : SdkLogger {

  data class LogEntry(
      val level: String,
      val tag: String,
      val message: String,
      val throwable: Throwable? = null,
  )

  private val _entries = mutableListOf<LogEntry>()
  val entries: List<LogEntry>
    get() = _entries.toList()

  override fun d(tag: String, msg: () -> String) {
    _entries.add(LogEntry("D", tag, msg()))
  }

  override fun i(tag: String, msg: () -> String) {
    _entries.add(LogEntry("I", tag, msg()))
  }

  override fun w(tag: String, tr: Throwable?, msg: () -> String) {
    _entries.add(LogEntry("W", tag, msg(), tr))
  }

  override fun e(tag: String, tr: Throwable?, msg: () -> String) {
    _entries.add(LogEntry("E", tag, msg(), tr))
  }

  fun clear() {
    _entries.clear()
  }
}
