package dev.jasonpearson.automobile.ctrlproxy

import android.util.Log
import dev.jasonpearson.automobile.protocol.LogEventData
import dev.jasonpearson.automobile.protocol.LogEventResponse
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import java.io.BufferedReader
import java.io.InputStreamReader

/**
 * Reads logcat output in real-time and broadcasts [LogEventResponse] objects.
 *
 * Runs `logcat -v threadtime -T 1` to capture only new entries, parses each line with the
 * threadtime format, and invokes [onLogEvent] for every successfully parsed entry.
 *
 * Lifecycle: [start] from onServiceConnected, [stop] from onDestroy. Auto-reconnects if the logcat
 * process dies unexpectedly.
 */
class LogcatReader(private val onLogEvent: (WebSocketResponse) -> Unit) {

  companion object {
    private const val TAG = "LogcatReader"

    /**
     * Threadtime format: `MM-DD HH:MM:SS.mmm PID TID level tag: message`
     *
     * Example: `04-01 12:34:56.789 1234 5678 D MyTag : Hello world`
     */
    private val THREADTIME_REGEX =
      Regex(
        """^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.+?)\s*:\s(.*)$"""
      )

    /** Maps logcat level letters to Android Log level constants. */
    private fun parseLevel(letter: String): Int =
      when (letter) {
        "V" -> 2 // Log.VERBOSE
        "D" -> 3 // Log.DEBUG
        "I" -> 4 // Log.INFO
        "W" -> 5 // Log.WARN
        "E" -> 6 // Log.ERROR
        "F" -> 7 // Log.ASSERT (fatal)
        "A" -> 7 // Log.ASSERT
        else -> 4 // default to INFO
      }
  }

  @Volatile private var running = false
  private var readerThread: Thread? = null
  private var logcatProcess: Process? = null

  /**
   * Start reading logcat on a background thread. Safe to call multiple times; subsequent calls are
   * no-ops while running.
   */
  fun start() {
    if (running) return
    running = true
    readerThread =
      Thread(
          {
            while (running) {
              try {
                readLogcat()
                // Normal exit (EOF) — backoff before restarting
                if (!running) break
                Log.d(TAG, "Logcat process exited, restarting in 1s")
                Thread.sleep(1000)
              } catch (e: InterruptedException) {
                break
              } catch (e: Exception) {
                if (!running) break
                Log.w(TAG, "Logcat process died, restarting in 1s", e)
                try {
                  Thread.sleep(1000)
                } catch (_: InterruptedException) {
                  break
                }
              }
            }
          },
          "LogcatReader",
        )
        .apply {
          isDaemon = true
          start()
        }
  }

  /** Stop the logcat reader and clean up resources. */
  fun stop() {
    running = false
    logcatProcess?.destroy()
    logcatProcess = null
    readerThread?.interrupt()
    readerThread = null
  }

  private fun readLogcat() {
    val process = Runtime.getRuntime().exec(arrayOf("logcat", "-v", "threadtime", "-T", "1"))
    logcatProcess = process

    val reader = BufferedReader(InputStreamReader(process.inputStream))
    try {
      var line = reader.readLine()
      while (line != null && running) {
        parseLine(line)?.let { response ->
          try {
            onLogEvent(response)
          } catch (e: Exception) {
            Log.w(TAG, "Error broadcasting log event", e)
          }
        }
        line = reader.readLine()
      }
    } finally {
      reader.close()
      process.destroy()
      logcatProcess = null
    }
  }

  /**
   * Parse a single threadtime-formatted logcat line into a [LogEventResponse]. Returns null for
   * lines that don't match the expected format (e.g., headers).
   */
  internal fun parseLine(line: String): LogEventResponse? {
    val match = THREADTIME_REGEX.matchEntire(line) ?: return null
    val (_, _, pidStr, tidStr, levelStr, tag, message) = match.destructured

    val pid = pidStr.toIntOrNull() ?: 0
    val tid = tidStr.toIntOrNull() ?: 0
    val level = parseLevel(levelStr)

    return LogEventResponse(
      timestamp = System.currentTimeMillis(),
      event =
        LogEventData(
          level = level,
          tag = tag.trim(),
          message = message,
          pid = pid,
          tid = tid,
        ),
    )
  }
}
