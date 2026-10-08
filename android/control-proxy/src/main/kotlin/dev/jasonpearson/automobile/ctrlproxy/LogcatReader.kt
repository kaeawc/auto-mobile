package dev.jasonpearson.automobile.ctrlproxy

import android.os.Process as AndroidProcess
import android.util.Log
import dev.jasonpearson.automobile.ctrlproxy.perf.SystemTimeProvider
import dev.jasonpearson.automobile.ctrlproxy.perf.TimeProvider
import dev.jasonpearson.automobile.protocol.LogEventData
import dev.jasonpearson.automobile.protocol.LogEventResponse
import dev.jasonpearson.automobile.protocol.WebSocketResponse
import java.io.BufferedReader
import java.io.InputStreamReader
import kotlinx.coroutines.channels.Channel

/** Parses one logcat line before the resulting event enters the shared delivery queue. */
internal fun interface LogLineParser {
  fun parse(line: String): LogEventResponse?
}

internal class ThreadtimeLogLineParser(
  private val timeProvider: TimeProvider = SystemTimeProvider(),
) : LogLineParser {
  companion object {
    /** Threadtime format: `MM-DD HH:MM:SS.mmm PID TID level tag: message`. */
    private val THREADTIME_REGEX =
      Regex(
        """^(\d{2}-\d{2})\s+(\d{2}:\d{2}:\d{2}\.\d{3})\s+(\d+)\s+(\d+)\s+([VDIWEFA])\s+(.+?)\s*:\s(.*)$""",
      )

    private fun parseLevel(letter: String): Int =
      when (letter) {
        "V" -> 2
        "D" -> 3
        "I" -> 4
        "W" -> 5
        "E" -> 6
        "F",
        "A" -> 7
        else -> 4
      }
  }

  override fun parse(line: String): LogEventResponse? {
    // Skip non-entry headers before the regex match.
    if (line.length < 2 || !line[0].isDigit() || !line[1].isDigit()) return null
    val match = THREADTIME_REGEX.matchEntire(line) ?: return null
    val (_, _, pidStr, tidStr, levelStr, tag, message) = match.destructured
    return LogEventResponse(
      timestamp = timeProvider.currentTimeMillis(),
      event =
        LogEventData(
          level = parseLevel(levelStr),
          tag = tag.trim(),
          message = message,
          pid = pidStr.toIntOrNull() ?: 0,
          tid = tidStr.toIntOrNull() ?: 0,
        ),
    )
  }
}

/** Single-consumer, bounded log queue. Recent warnings/errors displace older queued lines. */
internal class BoundedLogBuffer(
  capacity: Int,
  private val stats: CtrlProxyWorkStats,
) {
  val channel = Channel<WebSocketResponse>(capacity)

  fun offer(response: WebSocketResponse): Boolean {
    if (channel.trySend(response).isSuccess) return true
    if (response is LogEventResponse && response.event.level >= Log.WARN) {
      if (channel.tryReceive().isSuccess) stats.droppedOverflowLogLines.incrementAndGet()
      return channel.trySend(response).isSuccess
    }
    return false
  }
}

/**
 * Reads logcat output in real-time and broadcasts [LogEventResponse] objects.
 *
 * Runs `logcat -v threadtime -T 1` to capture only new entries, parses each line with the
 * threadtime format, and invokes [onLogEvent] for every successfully parsed entry.
 *
 * When no client is consuming logs ([hasConsumer] returns false), delivered lines are dropped
 * before the threadtime match and [LogEventResponse] allocation, so a chatty device does not pay
 * for regex + allocation per log line that would be delivered to nobody.
 *
 * Lifecycle: [start] from onServiceConnected, [stop] from onDestroy. Auto-reconnects if the logcat
 * process dies unexpectedly.
 *
 * @param hasConsumer seam returning whether any client is currently connected; injected so the gate
 *   is unit-testable without a live WebSocket. Defaults to always-on for callers that never gate.
 */
class LogcatReader
internal constructor(
  private val onLogEvent: (WebSocketResponse) -> Unit,
  private val hasConsumer: () -> Boolean = { true },
  private val tryDeliver: ((WebSocketResponse) -> Boolean)? = null,
  private val ownPid: () -> Int = { runCatching { AndroidProcess.myPid() }.getOrDefault(-1) },
  internal val stats: CtrlProxyWorkStats = CtrlProxyWorkStats(),
  private val parser: LogLineParser = ThreadtimeLogLineParser(),
) {
  private val processId = ownPid()

  companion object {
    private const val TAG = "LogcatReader"
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
        handleLine(line)
        line = reader.readLine()
      }
    } finally {
      reader.close()
      process.destroy()
      logcatProcess = null
    }
  }

  /**
   * Gate + parse + broadcast a single raw logcat line. Drops the line before any parsing or
   * allocation when [hasConsumer] reports no connected client, so nothing is parsed for nobody.
   */
  internal fun handleLine(line: String) {
    // No client is consuming logs — skip the regex match + LogEventResponse allocation entirely.
    if (!hasConsumer()) return
    // Read the fixed threadtime header without regex or event allocation. Only suppress this
    // process's verbose/debug diagnostics; app logs and our warnings/errors retain their priority.
    if (isOwnDiagnostic(line)) {
      stats.droppedInternalLogLines.incrementAndGet()
      return
    }
    parser.parse(line)?.let { response ->
      try {
        val accepted =
          tryDeliver?.invoke(response)
            ?: run {
              onLogEvent(response)
              true
            }
        if (accepted) stats.forwardedLogLines.incrementAndGet()
        else stats.droppedOverflowLogLines.incrementAndGet()
      } catch (e: Exception) {
        Log.w(TAG, "Error broadcasting log event", e)
      }
    }
  }

  private fun isOwnDiagnostic(line: String): Boolean {
    if (line.length < 22) return false
    var index = 18 // after MM-DD HH:MM:SS.mmm
    while (index < line.length && line[index] == ' ') index++
    val pidStart = index
    var pid = 0
    while (index < line.length && line[index].isDigit()) {
      pid = pid * 10 + (line[index] - '0')
      index++
    }
    if (pidStart == index || pid != processId) return false
    while (index < line.length && line[index] == ' ') index++
    while (index < line.length && line[index].isDigit()) index++ // TID
    while (index < line.length && line[index] == ' ') index++
    return index < line.length &&
      (line[index] == 'D' || line[index] == 'V') &&
      index + 1 < line.length &&
      line[index + 1] == ' '
  }
}
