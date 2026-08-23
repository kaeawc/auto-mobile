package dev.jasonpearson.automobile.desktop.core.mcp

import java.io.File
import java.nio.file.Files
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.After
import org.junit.Test

class McpProcessDetectorTest {

  private val timeProvider = FakeTimeProvider(currentTime = 1_700_000_000_000L)

  private val tempDirs = mutableListOf<File>()

  private fun newTempDir(): File =
    Files.createTempDirectory("am-socket-detect").toFile().also { tempDirs += it }

  @After
  fun cleanUp() {
    tempDirs.forEach { it.deleteRecursively() }
    tempDirs.clear()
  }

  @Test
  fun `only the unix-socket transport supports daemon input`() {
    // Device control (issue #3347) gates on this: the Unix-socket daemon (McpDaemonClient) is the
    // only transport whose inputTap/inputSwipe reach the device; HTTP and STDIO reject them.
    assertTrue(McpConnectionType.UnixSocket.supportsDaemonInput)
    assertFalse(McpConnectionType.StreamableHttp.supportsDaemonInput)
    assertFalse(McpConnectionType.Stdio.supportsDaemonInput)
  }

  @Test
  fun parseProcessLineExtractsPidAndCommand() {
    val detector =
      RealMcpProcessDetector(
        timeProvider = timeProvider,
        processRunner = FakeProcessRunner(),
        socketFileChecker = FakeSocketFileChecker(),
      )
    val line = "97956 Wed Jan 22 11:00:00 2025 bun /path/to/auto-mobile --daemon-mode"
    val info = detector.parseProcessLine(line)

    assertNotNull(info)
    assertEquals(97956, info.pid)
    assertEquals("auto-mobile", info.name)
  }

  @Test
  fun parseProcessLineReturnsNullForShortLine() {
    val detector =
      RealMcpProcessDetector(
        timeProvider = timeProvider,
        processRunner = FakeProcessRunner(),
        socketFileChecker = FakeSocketFileChecker(),
      )
    val info = detector.parseProcessLine("123 short")
    assertNull(info)
  }

  @Test
  fun parseProcessLineReturnsNullForNonNumericPid() {
    val detector =
      RealMcpProcessDetector(
        timeProvider = timeProvider,
        processRunner = FakeProcessRunner(),
        socketFileChecker = FakeSocketFileChecker(),
      )
    val info = detector.parseProcessLine("abc Wed Jan 22 11:00:00 2025 bun /path/to/auto-mobile")
    assertNull(info)
  }

  @Test
  fun extractProcessNameRecognizesDaemon() {
    val detector =
      RealMcpProcessDetector(
        timeProvider = timeProvider,
        processRunner = FakeProcessRunner(),
        socketFileChecker = FakeSocketFileChecker(),
      )
    assertEquals(
      "auto-mobile-daemon",
      detector.extractProcessName("bun /path/to/auto-mobile-daemon"),
    )
    assertEquals("auto-mobile", detector.extractProcessName("bun /path/to/auto-mobile --stdio"))
  }

  @Test
  fun extractPortFromCommandLine() {
    val detector =
      RealMcpProcessDetector(
        timeProvider = timeProvider,
        processRunner = FakeProcessRunner(),
        socketFileChecker = FakeSocketFileChecker(),
      )
    assertEquals(9164, detector.extractPort("--port 9164"))
    assertEquals(9164, detector.extractPort("--port=9164"))
    assertEquals(3000, detector.extractPort("localhost:3000/health"))
    assertNull(detector.extractPort("--no-port-here"))
  }

  @Test
  fun classifyConnectionReturnsUnixSocketWhenSocketPathPresent() {
    val detector =
      RealMcpProcessDetector(
        timeProvider = timeProvider,
        processRunner = FakeProcessRunner(),
        socketFileChecker = FakeSocketFileChecker(),
      )
    val (type, port, path) =
      detector.classifyConnection(
        socketPath = "/tmp/auto-mobile-daemon-501.sock",
        cmdLine = "bun /path/to/auto-mobile",
      )
    assertEquals(McpConnectionType.UnixSocket, type)
    assertNull(port)
    assertEquals("/tmp/auto-mobile-daemon-501.sock", path)
  }

  @Test
  fun classifyConnectionReturnsHttpForDaemonMode() {
    val detector =
      RealMcpProcessDetector(
        timeProvider = timeProvider,
        processRunner = FakeProcessRunner(),
        socketFileChecker = FakeSocketFileChecker(),
      )
    val (type, port, path) =
      detector.classifyConnection(
        socketPath = null,
        cmdLine = "bun /path/to/auto-mobile --daemon-mode --port 9164",
      )
    assertEquals(McpConnectionType.StreamableHttp, type)
    assertEquals(9164, port)
    assertNull(path)
  }

  @Test
  fun classifyConnectionReturnsStdioByDefault() {
    val detector =
      RealMcpProcessDetector(
        timeProvider = timeProvider,
        processRunner = FakeProcessRunner(),
        socketFileChecker = FakeSocketFileChecker(),
      )
    val (type, port, path) =
      detector.classifyConnection(
        socketPath = null,
        cmdLine = "bun /path/to/auto-mobile --stdio",
      )
    assertEquals(McpConnectionType.Stdio, type)
    assertNull(port)
    assertNull(path)
  }

  @Test
  fun fastPathSkipsLsofWhenNoSocketFilesExist() {
    val psRunner =
      FakeProcessRunner(
        responses =
          mapOf(
            listOf("ps", "-eo", "pid,lstart,command") to
              listOf("97956 Wed Jan 22 11:00:00 2025 bun /path/to/auto-mobile --stdio")
          )
      )
    val detector =
      RealMcpProcessDetector(
        timeProvider = timeProvider,
        processRunner = psRunner,
        socketFileChecker = FakeSocketFileChecker(files = emptyList()),
      )

    val processes = detector.detectProcesses()

    assertEquals(1, processes.size)
    assertEquals(McpConnectionType.Stdio, processes[0].connectionType)
    // lsof should never have been called
    assertEquals(
      listOf(listOf("ps", "-eo", "pid,lstart,command")),
      psRunner.commandsExecuted,
    )
  }

  @Test
  fun detectsUnixSocketWhenSocketFileExistsAndLsofFindsIt() {
    val psRunner =
      FakeProcessRunner(
        responses =
          mapOf(
            listOf("ps", "-eo", "pid,lstart,command") to
              listOf("97956 Wed Jan 22 11:00:00 2025 bun /path/to/auto-mobile"),
            listOf("lsof", "-p", "97956", "-a", "-U") to
              listOf("bun  97956 jason  17u  unix 0x1234 0t0  /tmp/auto-mobile-daemon-501.sock"),
          )
      )
    val detector =
      RealMcpProcessDetector(
        timeProvider = timeProvider,
        processRunner = psRunner,
        socketFileChecker =
          FakeSocketFileChecker(files = listOf("/tmp/auto-mobile-daemon-501.sock")),
      )

    val processes = detector.detectProcesses()

    assertEquals(1, processes.size)
    assertEquals(McpConnectionType.UnixSocket, processes[0].connectionType)
    assertEquals("/tmp/auto-mobile-daemon-501.sock", processes[0].socketPath)
  }

  @Test
  fun `isListeningOnSocket resolves the configured override path over the first-socket fallback`() {
    // A daemon on an AUTOMOBILE_DAEMON_SOCKET_PATH override outside /tmp must be recognized by its
    // actual listening path (issue #4848), not silently mislabeled with the first discovered
    // socket.
    val overridePath = "/custom/run/auto-mobile.sock"
    val psRunner =
      FakeProcessRunner(
        responses =
          mapOf(
            listOf("ps", "-eo", "pid,lstart,command") to
              listOf("97956 Wed Jan 22 11:00:00 2025 bun /path/to/auto-mobile"),
            listOf("lsof", "-p", "97956", "-a", "-U") to
              listOf("bun  97956 jason  17u  unix 0x1234 0t0  $overridePath"),
          )
      )
    val detector =
      RealMcpProcessDetector(
        timeProvider = timeProvider,
        processRunner = psRunner,
        // First entry is a decoy so the fallback (firstOrNull) would pick the wrong path.
        socketFileChecker =
          FakeSocketFileChecker(files = listOf("/tmp/auto-mobile-daemon-999.sock", overridePath)),
        configuredSocketPath = { overridePath },
      )

    val processes = detector.detectProcesses()

    assertEquals(1, processes.size)
    assertEquals(McpConnectionType.UnixSocket, processes[0].connectionType)
    assertEquals(overridePath, processes[0].socketPath)
  }

  @Test
  fun `isListeningOnSocket matches an override socket path containing whitespace`() {
    // lsof's NAME column is the trailing field and can contain spaces; matching the last
    // whitespace token would drop everything before the space and fall through to the /tmp decoy.
    val overridePath = "/Users/me/Application Support/auto-mobile.sock"
    val psRunner =
      FakeProcessRunner(
        responses =
          mapOf(
            listOf("ps", "-eo", "pid,lstart,command") to
              listOf("97956 Wed Jan 22 11:00:00 2025 bun /path/to/auto-mobile"),
            listOf("lsof", "-p", "97956", "-a", "-U") to
              listOf("bun  97956 jason  17u  unix 0x1234 0t0  $overridePath"),
          )
      )
    val detector =
      RealMcpProcessDetector(
        timeProvider = timeProvider,
        processRunner = psRunner,
        socketFileChecker =
          FakeSocketFileChecker(files = listOf("/tmp/auto-mobile-daemon-999.sock", overridePath)),
        configuredSocketPath = { overridePath },
      )

    val processes = detector.detectProcesses()

    assertEquals(1, processes.size)
    assertEquals(McpConnectionType.UnixSocket, processes[0].connectionType)
    assertEquals(overridePath, processes[0].socketPath)
  }

  @Test
  fun `RealSocketFileChecker scans the default socket directory`() {
    val dir = newTempDir()
    File(dir, "auto-mobile-daemon-501.sock").createNewFile()
    File(dir, "unrelated.sock").createNewFile()
    File(dir, "auto-mobile-daemon-501.pid").createNewFile()

    val checker =
      RealSocketFileChecker(
        defaultSocketDir = dir,
        configuredSocketPath = { File(dir, "auto-mobile-daemon-501.sock").absolutePath },
      )

    assertEquals(
      listOf(File(dir, "auto-mobile-daemon-501.sock").absolutePath),
      checker.findDaemonSocketFiles(),
    )
  }

  @Test
  fun `RealSocketFileChecker includes an existing override socket outside the default directory`() {
    val defaultDir = newTempDir()
    val overrideDir = newTempDir()
    File(defaultDir, "auto-mobile-daemon-501.sock").createNewFile()
    val overrideSock = File(overrideDir, "custom-daemon.sock").apply { createNewFile() }

    val checker =
      RealSocketFileChecker(
        defaultSocketDir = defaultDir,
        configuredSocketPath = { overrideSock.absolutePath },
      )

    assertEquals(
      listOf(
        File(defaultDir, "auto-mobile-daemon-501.sock").absolutePath,
        overrideSock.absolutePath,
      ),
      checker.findDaemonSocketFiles(),
    )
  }

  @Test
  fun `RealSocketFileChecker omits an override socket that does not exist`() {
    val defaultDir = newTempDir()
    val overrideDir = newTempDir()

    val checker =
      RealSocketFileChecker(
        defaultSocketDir = defaultDir,
        configuredSocketPath = { File(overrideDir, "missing.sock").absolutePath },
      )

    assertTrue(checker.findDaemonSocketFiles().isEmpty())
  }
}

private class FakeProcessRunner(
  private val responses: Map<List<String>, List<String>> = emptyMap()
) : ProcessRunner {
  val commandsExecuted = mutableListOf<List<String>>()

  override fun runAndReadLines(command: List<String>): List<String>? {
    commandsExecuted.add(command)
    return responses[command]
  }
}

private class FakeSocketFileChecker(private val files: List<String> = emptyList()) :
  SocketFileChecker {
  override fun findDaemonSocketFiles(): List<String> = files
}
