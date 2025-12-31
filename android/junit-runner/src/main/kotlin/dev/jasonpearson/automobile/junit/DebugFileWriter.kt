package dev.jasonpearson.automobile.junit

import java.io.File
import java.text.SimpleDateFormat
import java.util.Date
import java.util.Locale

/**
 * Utility for writing debug information to files in the scratch/debug directory
 */
class DebugFileWriter(prefix: String) {
  private val debugDir: File
  private val debugFile: File
  private val buffer = StringBuilder()

  init {
    // Get project root directory (assuming we're running from project root)
    val projectRoot = File(System.getProperty("user.dir"))
    debugDir = File(projectRoot, "scratch/debug")

    // Create debug directory if it doesn't exist
    if (!debugDir.exists()) {
      debugDir.mkdirs()
    }

    // Create debug file with timestamp
    val timestamp = formatFilenameTimestamp()
    val filename = "$prefix-$timestamp.log"
    debugFile = File(debugDir, filename)
  }

  /**
   * Gets the absolute path to the debug file
   */
  fun getFilePath(): String = debugFile.absolutePath

  /**
   * Formats a timestamp for display in debug files
   */
  private fun formatTimestamp(date: Date = Date()): String {
    val format = SimpleDateFormat("yyyy-MM-dd HH:mm:ss.SSS", Locale.US)
    return format.format(date)
  }

  /**
   * Formats a timestamp for use in filenames (no spaces or colons)
   */
  private fun formatFilenameTimestamp(date: Date = Date()): String {
    val format = SimpleDateFormat("yyyy-MM-dd_HH-mm-ss-SSS", Locale.US)
    return format.format(date)
  }

  /**
   * Adds a section to the debug output
   */
  fun addSection(title: String, content: String? = null): DebugFileWriter {
    val separator = "=".repeat(80)
    buffer.appendLine(separator)
    buffer.appendLine("[${formatTimestamp()}] $title")
    buffer.appendLine(separator)

    content?.let {
      buffer.appendLine(it)
      buffer.appendLine() // Empty line after content
    }

    return this
  }

  /**
   * Adds a subsection to the debug output
   */
  fun addSubsection(title: String, content: String? = null): DebugFileWriter {
    val separator = "-".repeat(80)
    buffer.appendLine(separator)
    buffer.appendLine(title)
    buffer.appendLine(separator)

    content?.let {
      buffer.appendLine(it)
      buffer.appendLine() // Empty line after content
    }

    return this
  }

  /**
   * Adds a timestamped entry to the debug output
   */
  fun addEntry(message: String): DebugFileWriter {
    buffer.appendLine("[${formatTimestamp()}] $message")
    buffer.appendLine() // Empty line after entry
    return this
  }

  /**
   * Adds raw content to the debug output
   */
  fun addContent(content: String): DebugFileWriter {
    buffer.appendLine(content)
    buffer.appendLine() // Empty line after content
    return this
  }

  /**
   * Adds a key-value pair to the debug output
   */
  fun addKeyValue(key: String, value: Any?): DebugFileWriter {
    buffer.appendLine("$key: $value")
    return this
  }

  /**
   * Adds multiple key-value pairs to the debug output
   */
  fun addKeyValues(vararg pairs: Pair<String, Any?>): DebugFileWriter {
    pairs.forEach { (key, value) ->
      addKeyValue(key, value)
    }
    buffer.appendLine() // Empty line after all pairs
    return this
  }

  /**
   * Adds timing information to the debug output
   */
  fun addTiming(label: String, durationMs: Long): DebugFileWriter {
    buffer.appendLine("$label: ${durationMs}ms")
    return this
  }

  /**
   * Adds an error to the debug output
   */
  fun addError(error: Throwable): DebugFileWriter {
    val separator = "-".repeat(80)
    buffer.appendLine(separator)
    buffer.appendLine("ERROR")
    buffer.appendLine(separator)
    buffer.appendLine(error.message ?: "Unknown error")
    error.stackTrace.forEach { element ->
      buffer.appendLine("  at $element")
    }
    buffer.appendLine() // Empty line after error
    return this
  }

  /**
   * Adds an error message to the debug output
   */
  fun addError(errorMessage: String): DebugFileWriter {
    val separator = "-".repeat(80)
    buffer.appendLine(separator)
    buffer.appendLine("ERROR")
    buffer.appendLine(separator)
    buffer.appendLine(errorMessage)
    buffer.appendLine() // Empty line after error
    return this
  }

  /**
   * Writes the buffered content to the debug file
   */
  fun write() {
    debugFile.writeText(buffer.toString())
  }

  /**
   * Clears the buffer without writing
   */
  fun clear(): DebugFileWriter {
    buffer.clear()
    return this
  }
}
