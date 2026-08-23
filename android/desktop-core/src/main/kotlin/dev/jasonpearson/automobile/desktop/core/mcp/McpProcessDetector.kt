package dev.jasonpearson.automobile.desktop.core.mcp

import dev.jasonpearson.automobile.desktop.core.daemon.DaemonSocketPaths
import java.io.BufferedReader
import java.io.File
import java.io.InputStreamReader

/** Data class for MCP process information */
data class McpProcess(
  val pid: Int,
  val name: String,
  val connectionType: McpConnectionType,
  val port: Int? = null,
  val socketPath: String? = null,
  val uptimeMs: Long = 0,
  val status: String = "Running",
  val commandLine: String? = null,
)

enum class McpConnectionType(val label: String, val icon: String) {
  StreamableHttp("Streamable HTTP", "🌐"),
  Stdio("STDIO", "📝"),
  UnixSocket("Unix Socket", "🔌"),
}

/**
 * Whether this transport can carry the typed daemon input helpers (`input/tap`, `input/swipe`, …).
 * Only the Unix-socket daemon ([McpConnectionType.UnixSocket] / `McpDaemonClient`) implements them;
 * the HTTP and STDIO clients reject them with an "unsupported" error. Device-control (issue #3347)
 * gates on this so a control-mode click is only offered on a transport that can actually tap — on
 * an input-incapable transport we stay in inspector mode rather than suppress element selection for
 * clicks that would always fail.
 */
val McpConnectionType.supportsDaemonInput: Boolean
  get() = this == McpConnectionType.UnixSocket

/** Interface for detecting MCP server processes */
interface McpProcessDetector {
  fun detectProcesses(): List<McpProcess>
}

/** Fake implementation for testing and demo purposes */
class FakeMcpProcessDetector : McpProcessDetector {
  override fun detectProcesses(): List<McpProcess> =
    listOf(
      McpProcess(
        pid = 12345,
        name = "auto-mobile-daemon",
        connectionType = McpConnectionType.StreamableHttp,
        port = 3000,
        uptimeMs = 3600000, // 1 hour
      ),
      McpProcess(
        pid = 12346,
        name = "auto-mobile-mcp",
        connectionType = McpConnectionType.UnixSocket,
        socketPath = "/tmp/auto-mobile-daemon-501.sock",
        uptimeMs = 1800000, // 30 min
      ),
      McpProcess(
        pid = 12400,
        name = "auto-mobile-stdio",
        connectionType = McpConnectionType.Stdio,
        uptimeMs = 600000, // 10 min
      ),
    )
}

/** Runs a subprocess and returns its stdout lines, or null on failure. */
interface ProcessRunner {
  fun runAndReadLines(command: List<String>): List<String>?
}

class SystemProcessRunner : ProcessRunner {
  override fun runAndReadLines(command: List<String>): List<String>? {
    return try {
      val pb = ProcessBuilder(command)
      pb.redirectErrorStream(true)
      val process = pb.start()
      val lines =
        BufferedReader(InputStreamReader(process.inputStream)).use { reader ->
          reader.readLines()
        }
      process.waitFor()
      lines
    } catch (e: Exception) {
      null
    }
  }
}

/** Checks whether daemon socket files exist. */
interface SocketFileChecker {
  fun findDaemonSocketFiles(): List<String>
}

/**
 * Discovers daemon socket files by scanning the default `/tmp` location AND honoring the
 * `AUTOMOBILE_DAEMON_SOCKET_PATH` / `AUTO_MOBILE_DAEMON_SOCKET_PATH` overrides that the daemon
 * itself resolves through [DaemonSocketPaths.socketPath]. A daemon started with a socket outside
 * the default `/tmp/auto-mobile-daemon-*` path would otherwise be invisible to detection, so the
 * diagnostics health sheet reports "Not Connected" for a daemon that is actually up (issue #4848).
 */
class RealSocketFileChecker(
  private val defaultSocketDir: File = File("/tmp"),
  private val configuredSocketPath: () -> String = { DaemonSocketPaths.socketPath() },
) : SocketFileChecker {
  override fun findDaemonSocketFiles(): List<String> {
    // LinkedHashSet: preserve scan order while de-duplicating an override that sits under /tmp.
    val results = LinkedHashSet<String>()
    if (defaultSocketDir.isDirectory) {
      defaultSocketDir
        .listFiles { f -> f.name.startsWith("auto-mobile-daemon") && f.name.endsWith(".sock") }
        ?.forEach { results.add(it.absolutePath) }
    }
    val overrideSocket = File(configuredSocketPath())
    if (overrideSocket.exists()) results.add(overrideSocket.absolutePath)
    return results.toList()
  }
}

/** Real implementation that detects actual MCP processes on the system */
class RealMcpProcessDetector(
  private val timeProvider: TimeProvider = SystemTimeProvider,
  private val processRunner: ProcessRunner = SystemProcessRunner(),
  private val socketFileChecker: SocketFileChecker = RealSocketFileChecker(),
  private val configuredSocketPath: () -> String = { DaemonSocketPaths.socketPath() },
) : McpProcessDetector {

  override fun detectProcesses(): List<McpProcess> {
    val processes = mutableListOf<McpProcess>()

    // Find auto-mobile processes via ps
    val psProcesses = findAutoMobileProcesses()

    // Fast-path: check if any daemon socket files exist at all
    val socketFilesExist = socketFileChecker.findDaemonSocketFiles().isNotEmpty()

    // Match processes with their connection types
    psProcesses.forEach { (pid, name, startTime, cmdLine) ->
      val uptimeMs = timeProvider.currentTimeMillis() - startTime

      // Determine connection type: always prefer Unix socket if it exists
      val socketPath = if (socketFilesExist) isListeningOnSocket(pid) else null
      // Fallback: if socket files exist but this PID isn't listening, still use Unix socket
      // (the daemon PID in the PID file may differ from the detected process PID)
      val fallbackSocketPath =
        if (socketPath == null && socketFilesExist) {
          socketFileChecker.findDaemonSocketFiles().firstOrNull()
        } else null

      val (connectionType, port, resolvedSocketPath) =
        when {
          socketPath != null -> {
            Triple(McpConnectionType.UnixSocket, null, socketPath)
          }
          fallbackSocketPath != null &&
            (cmdLine.contains("--daemon-mode") || cmdLine.contains("auto-mobile")) -> {
            Triple(McpConnectionType.UnixSocket, null, fallbackSocketPath)
          }
          cmdLine.contains("--daemon-mode") -> {
            Triple(McpConnectionType.StreamableHttp, extractPort(cmdLine) ?: 3000, null)
          }
          cmdLine.contains("--port") || cmdLine.contains(":3000") || cmdLine.contains("http") -> {
            Triple(McpConnectionType.StreamableHttp, extractPort(cmdLine) ?: 3000, null)
          }
          else -> {
            Triple(McpConnectionType.Stdio, null, null)
          }
        }

      processes.add(
        McpProcess(
          pid = pid,
          name = name,
          connectionType = connectionType,
          port = port,
          socketPath = resolvedSocketPath,
          uptimeMs = uptimeMs,
          commandLine = cmdLine,
        )
      )
    }

    return processes
  }

  private fun findAutoMobileProcesses(): List<ProcessInfo> {
    val lines =
      processRunner.runAndReadLines(listOf("ps", "-eo", "pid,lstart,command")) ?: return emptyList()

    return lines
      .filter { it.contains("auto-mobile") && !it.contains("grep") }
      .mapNotNull { line -> parseProcessLine(line) }
  }

  internal fun parseProcessLine(line: String): ProcessInfo? {
    // Parse: "  PID                      STARTED COMMAND"
    // Example: "97956 Wed Jan 22 11:00:00 2025 bun /path/to/auto-mobile"
    val trimmed = line.trim()
    val parts = trimmed.split(Regex("\\s+"), limit = 6)

    if (parts.size < 6) return null

    val pid = parts[0].toIntOrNull() ?: return null

    // Parse lstart date (format: "Wed Jan 22 11:00:00 2025")
    val dateStr = "${parts[1]} ${parts[2]} ${parts[3]} ${parts[4]} ${parts[5].substringBefore(' ')}"
    val startTime = parseLstartDate(dateStr)

    val command = parts.getOrNull(5)?.substringAfter(' ') ?: parts[5]
    val name = extractProcessName(command)

    return ProcessInfo(pid, name, startTime, command)
  }

  private fun parseLstartDate(dateStr: String): Long {
    return try {
      val format = java.text.SimpleDateFormat("EEE MMM dd HH:mm:ss yyyy", java.util.Locale.US)
      format.parse(dateStr)?.time ?: timeProvider.currentTimeMillis()
    } catch (e: Exception) {
      timeProvider.currentTimeMillis()
    }
  }

  internal fun extractProcessName(command: String): String {
    return when {
      command.contains("auto-mobile-daemon") -> "auto-mobile-daemon"
      command.contains("auto-mobile") -> "auto-mobile"
      else -> command.substringAfterLast('/').substringBefore(' ')
    }
  }

  internal fun extractPort(cmdLine: String): Int? {
    val portRegex = Regex("--port[=\\s](\\d+)|:(\\d{4,5})")
    val match = portRegex.find(cmdLine)
    return match?.groupValues?.drop(1)?.firstOrNull { it.isNotEmpty() }?.toIntOrNull()
  }

  internal fun classifyConnection(
    socketPath: String?,
    cmdLine: String,
  ): Triple<McpConnectionType, Int?, String?> {
    return when {
      socketPath != null -> {
        Triple(McpConnectionType.UnixSocket, null, socketPath)
      }
      cmdLine.contains("--daemon-mode") -> {
        Triple(McpConnectionType.StreamableHttp, extractPort(cmdLine) ?: 3000, null)
      }
      cmdLine.contains("--port") || cmdLine.contains(":3000") || cmdLine.contains("http") -> {
        Triple(McpConnectionType.StreamableHttp, extractPort(cmdLine) ?: 3000, null)
      }
      else -> {
        Triple(McpConnectionType.Stdio, null, null)
      }
    }
  }

  private fun isListeningOnSocket(pid: Int): String? {
    val lines =
      processRunner.runAndReadLines(listOf("lsof", "-p", pid.toString(), "-a", "-U")) ?: return null

    // Match the default /tmp daemon sockets and the configured override path (issue #4848), so a
    // daemon listening on an AUTOMOBILE_DAEMON_SOCKET_PATH override is recognized here rather than
    // only falling through to the first-socket fallback in detectProcesses().
    //
    // lsof's NAME field is the trailing column and MAY contain spaces (e.g. a socket under
    // "Application Support"), so match the override against the whole line's suffix rather than its
    // last whitespace token. Default /tmp daemon sockets never contain spaces, so the token check
    // stays correct for them.
    val overridePath = configuredSocketPath()
    return lines
      .mapNotNull { line ->
        val trimmed = line.trim()
        when {
          overridePath.isNotEmpty() && trimmed.endsWith(overridePath) -> overridePath
          else ->
            trimmed.split(Regex("\\s+")).lastOrNull()?.takeIf {
              it.startsWith("/tmp/auto-mobile-daemon") && it.endsWith(".sock")
            }
        }
      }
      .firstOrNull()
  }

  internal data class ProcessInfo(
    val pid: Int,
    val name: String,
    val startTime: Long,
    val commandLine: String,
  )
}

/** Time provider interface for testing */
interface TimeProvider {
  fun currentTimeMillis(): Long
}

/** System time provider for production use */
object SystemTimeProvider : TimeProvider {
  override fun currentTimeMillis(): Long = System.currentTimeMillis()
}

/** Fake time provider for testing */
class FakeTimeProvider(var currentTime: Long = 0L) : TimeProvider {
  override fun currentTimeMillis(): Long = currentTime

  fun advanceBy(ms: Long) {
    currentTime += ms
  }
}
