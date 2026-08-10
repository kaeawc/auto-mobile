package dev.jasonpearson.automobile.desktop.core.daemon

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertTrue

class DesktopDaemonLifecycleTest {

  @Test
  fun `reuses a daemon with the desktop release version`() {
    val commands = FakeDaemonCommandExecutor()
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(true)),
        pidFileReader = FakeDaemonPidFileReader(listOf("0.0.40+gabc123")),
        commandExecutor = commands,
        timer = FakeDaemonRetryTimer(),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Ready>(result)
    assertFalse(result.restarted)
    assertTrue(commands.commands.isEmpty())
  }

  @Test
  fun `starts when a matching pid file remains after the daemon socket disappears`() {
    val commands = FakeDaemonCommandExecutor()
    val timer = FakeDaemonRetryTimer()
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(false, false, false, true)),
        pidFileReader =
          FakeDaemonPidFileReader(
            versions = listOf("0.0.40", "0.0.40"),
            launchArguments = listOf("--network-mockable"),
          ),
        commandExecutor = commands,
        timer = timer,
        packageRunnerResolver = FakeDaemonPackageRunnerResolver("bunx"),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Ready>(result)
    assertTrue(result.restarted)
    assertEquals(
      listOf(
        listOf(
          "bunx",
          "@kaeawc/auto-mobile@0.0.40",
          "--daemon",
          "start",
          "--network-mockable",
        )
      ),
      commands.commands,
    )
    assertEquals(listOf(150L, 150L), timer.delays)
  }

  @Test
  fun `retries a transient socket refusal before replacing a matching daemon`() {
    val commands = FakeDaemonCommandExecutor()
    val timer = FakeDaemonRetryTimer()
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(false, true)),
        pidFileReader = FakeDaemonPidFileReader(listOf("0.0.40")),
        commandExecutor = commands,
        timer = timer,
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Ready>(result)
    assertFalse(result.restarted)
    assertTrue(commands.commands.isEmpty())
    assertEquals(listOf(150L), timer.delays)
  }

  @Test
  fun `rejects a newer daemon without restarting it`() {
    val commands = FakeDaemonCommandExecutor()
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(true)),
        pidFileReader = FakeDaemonPidFileReader(listOf("0.0.41")),
        commandExecutor = commands,
        timer = FakeDaemonRetryTimer(),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Failure>(result)
    assertTrue(result.message.contains("newer"))
    assertTrue(commands.commands.isEmpty())
  }

  @Test
  fun `restarts a skewed daemon through the pinned desktop package`() {
    val commands = FakeDaemonCommandExecutor()
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(true, true)),
        pidFileReader = FakeDaemonPidFileReader(listOf("0.0.39", "0.0.40")),
        commandExecutor = commands,
        timer = FakeDaemonRetryTimer(),
        packageRunnerResolver = FakeDaemonPackageRunnerResolver("bunx"),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Ready>(result)
    assertTrue(result.restarted)
    assertEquals(
      listOf(listOf("bunx", "@kaeawc/auto-mobile@0.0.40", "--daemon", "restart")),
      commands.commands,
    )
  }

  @Test
  fun `falls back to npx with the yes flag when bun is unavailable`() {
    val commands = FakeDaemonCommandExecutor()
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(true, true)),
        pidFileReader = FakeDaemonPidFileReader(listOf("0.0.39", "0.0.40")),
        commandExecutor = commands,
        timer = FakeDaemonRetryTimer(),
        packageRunnerResolver = FakeDaemonPackageRunnerResolver("/usr/local/bin/npx"),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Ready>(result)
    assertEquals(
      listOf(
        listOf("/usr/local/bin/npx", "-y", "@kaeawc/auto-mobile@0.0.40", "--daemon", "restart")
      ),
      commands.commands,
    )
  }

  @Test
  fun `preserves the skewed daemon options when restarting`() {
    val commands = FakeDaemonCommandExecutor()
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(true, true)),
        pidFileReader =
          FakeDaemonPidFileReader(
            versions = listOf("0.0.39", "0.0.40"),
            launchArguments = listOf("--network-mockable", "--video-fps", "30"),
          ),
        commandExecutor = commands,
        timer = FakeDaemonRetryTimer(),
        packageRunnerResolver = FakeDaemonPackageRunnerResolver("bunx"),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Ready>(result)
    assertEquals(
      listOf(
        listOf(
          "bunx",
          "@kaeawc/auto-mobile@0.0.40",
          "--daemon",
          "restart",
          "--network-mockable",
          "--video-fps",
          "30",
        )
      ),
      commands.commands,
    )
  }

  @Test
  fun `restarts a daemon that becomes reachable before PID state is available`() {
    val commands = FakeDaemonCommandExecutor()
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(false, true)),
        pidFileReader = FakeDaemonPidFileReader(listOf(null, "0.0.40")),
        commandExecutor = commands,
        timer = FakeDaemonRetryTimer(),
        packageRunnerResolver = FakeDaemonPackageRunnerResolver("bunx"),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Ready>(result)
    assertTrue(result.restarted)
    assertEquals(
      listOf(listOf("bunx", "@kaeawc/auto-mobile@0.0.40", "--daemon", "restart")),
      commands.commands,
    )
  }

  @Test
  fun `reports source build skew instead of launching a release daemon`() {
    val commands = FakeDaemonCommandExecutor()
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40+gabc123" },
        socketChecker = FakeDaemonSocketChecker(listOf(true)),
        pidFileReader = FakeDaemonPidFileReader(listOf(null, "0.0.40+gdef456")),
        commandExecutor = commands,
        timer = FakeDaemonRetryTimer(),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Failure>(result)
    assertTrue(result.message.contains("source build"))
    assertTrue(commands.commands.isEmpty())
  }

  @Test
  fun `reports an actionable error when the restarted daemon remains skewed`() {
    val timer = FakeDaemonRetryTimer()
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(true, true, true)),
        pidFileReader = FakeDaemonPidFileReader(listOf("0.0.39", "0.0.39")),
        commandExecutor = FakeDaemonCommandExecutor(),
        timer = timer,
        verificationAttempts = 2,
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Failure>(result)
    assertTrue(result.message.contains("0.0.39"))
    assertTrue(result.message.contains("0.0.40"))
    assertEquals(listOf(100L), timer.delays)
  }

  @Test
  fun `reports installation guidance when the pinned launch command fails without output`() {
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(false)),
        pidFileReader = FakeDaemonPidFileReader(listOf(null)),
        commandExecutor = FakeDaemonCommandExecutor(exitCode = 1, output = ""),
        timer = FakeDaemonRetryTimer(),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Failure>(result)
    assertTrue(result.message.contains("Install @kaeawc/auto-mobile@0.0.40"))
  }

  @Test
  fun `reports an actionable error when the pinned launch command times out`() {
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(false)),
        pidFileReader = FakeDaemonPidFileReader(listOf(null)),
        commandExecutor = FakeDaemonCommandExecutor(exitCode = -1, timedOut = true),
        timer = FakeDaemonRetryTimer(),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Failure>(result)
    assertTrue(result.message.contains("Timed out"))
  }

  @Test
  fun `wraps the resolved runner in the Windows command shim`() {
    val lifecycle = DesktopDaemonLifecycle()

    assertEquals(
      listOf("cmd.exe", "/d", "/v:off", "/s", "/c", "\"\"bunx.exe\" \"-y\"\""),
      lifecycle.commandForPlatform(listOf("bunx.exe", "-y"), "Windows 11"),
    )
  }

  @Test
  fun `adds the yes flag only for npx runners`() {
    val lifecycle = DesktopDaemonLifecycle()

    assertFalse(lifecycle.usesYesFlag("bunx"))
    assertFalse(lifecycle.usesYesFlag("/Users/dev/.bun/bin/bunx"))
    assertFalse(lifecycle.usesYesFlag("bunx.exe"))
    assertTrue(lifecycle.usesYesFlag("npx"))
    assertTrue(lifecycle.usesYesFlag("/usr/local/bin/npx"))
    assertTrue(lifecycle.usesYesFlag("npx.cmd"))
  }

  @Test
  fun `prefers a probed bun install over PATH lookups`() {
    val onPathQueries = mutableListOf<String>()
    val resolver =
      SystemDaemonPackageRunnerResolver(
        home = "/Users/dev",
        executableAt = { it == "/Users/dev/.bun/bin/bunx" },
        listDir = { emptyList() },
        onPath = { runner, _ ->
          onPathQueries += runner
          null
        },
      )

    assertEquals("/Users/dev/.bun/bin/bunx", resolver.resolve("Mac OS X"))
    assertTrue(onPathQueries.isEmpty())
  }

  @Test
  fun `resolves the newest nvm-installed node before the volta fallback`() {
    val resolver =
      SystemDaemonPackageRunnerResolver(
        home = "/Users/dev",
        executableAt = { it.startsWith("/Users/dev/.nvm/") || it == "/Users/dev/.volta/bin/npx" },
        listDir = { dir ->
          if (dir == "/Users/dev/.nvm/versions/node") listOf("v16.20.2", "v20.11.1", "v18.19.0")
          else emptyList()
        },
        onPath = { _, _ -> null },
      )

    // Newest installed version wins over older ones and the Volta fallback.
    assertEquals("/Users/dev/.nvm/versions/node/v20.11.1/bin/npx", resolver.resolve("Mac OS X"))
  }

  @Test
  fun `falls back to a PATH runner then the npx name`() {
    val resolver =
      SystemDaemonPackageRunnerResolver(
        home = "/Users/dev",
        executableAt = { false },
        listDir = { emptyList() },
        onPath = { runner, _ -> if (runner == "npx") "/opt/npx" else null },
      )

    assertEquals("/opt/npx", resolver.resolve("Mac OS X"))

    val unresolved =
      SystemDaemonPackageRunnerResolver(
        home = "/Users/dev",
        executableAt = { false },
        listDir = { emptyList() },
        onPath = { _, _ -> null },
      )

    assertEquals("npx", unresolved.resolve("Mac OS X"))
    assertEquals("npx.cmd", unresolved.resolve("Windows 11"))
  }

  @Test
  fun `extends the command timeout for a configured daemon startup timeout`() {
    assertEquals(125_000L, SystemDaemonCommandExecutor.commandTimeoutMillis("120000"))
    assertEquals(60_000L, SystemDaemonCommandExecutor.commandTimeoutMillis("invalid"))
  }

  @Test
  fun `retries a transient PID-file read before deciding to restart`() {
    val commands = FakeDaemonCommandExecutor()
    val timer = FakeDaemonRetryTimer()
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(true)),
        pidFileReader =
          FakeDaemonPidFileReader(
            results =
              listOf(
                DaemonPidReadResult.Unreadable,
                DaemonPidReadResult.Present(DaemonPidState("0.0.40")),
              )
          ),
        commandExecutor = commands,
        timer = timer,
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Ready>(result)
    assertFalse(result.restarted)
    assertTrue(commands.commands.isEmpty())
    assertEquals(listOf(100L), timer.delays)
  }

  @Test
  fun `does not restart while the daemon PID-file remains unreadable`() {
    val commands = FakeDaemonCommandExecutor()
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(true)),
        pidFileReader = FakeDaemonPidFileReader(results = listOf(DaemonPidReadResult.Unreadable)),
        commandExecutor = commands,
        timer = FakeDaemonRetryTimer(),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Failure>(result)
    assertTrue(result.message.contains("Could not read"))
    assertTrue(commands.commands.isEmpty())
  }

  @Test
  fun `reads supported daemon options as restart arguments`() {
    val pidFile = Files.createTempFile("automobile-daemon", ".json").toFile()
    pidFile.writeText(
      """
      {"version":"0.0.39","options":{"networkMockable":true,"videoFps":30,"eventAllMarkers":["login","save"]}}
      """
        .trimIndent()
    )

    try {
      val result = JsonDaemonPidFileReader(pidFile.absolutePath).read()
      val state = assertIs<DaemonPidReadResult.Present>(result).state

      assertEquals("0.0.39", state.version)
      assertEquals(
        listOf("--video-fps", "30", "--network-mockable", "--event-all-markers", "login,save"),
        state.launchArguments,
      )
    } finally {
      pidFile.delete()
    }
  }

  @Test
  fun `resolves PID-file overrides using the daemon launch directory`() {
    assertEquals(
      "/tmp/automobile/daemon.pid",
      DaemonSocketPaths.resolveDaemonPath("daemon.pid", "/tmp/default.pid", "/tmp/automobile"),
    )
    assertEquals(
      "/var/run/automobile.pid",
      DaemonSocketPaths.resolveDaemonPath(
        "/var/run/automobile.pid",
        "/tmp/default.pid",
        "/tmp/automobile",
      ),
    )
  }

  private class FakeDaemonSocketChecker(private val states: List<Boolean>) : DaemonSocketChecker {
    private var reads = 0

    override fun isReady(): Boolean {
      val index = reads.coerceAtMost(states.lastIndex)
      reads++
      return states[index]
    }
  }

  private class FakeDaemonPidFileReader(
    private val versions: List<String?> = emptyList(),
    private val launchArguments: List<String> = emptyList(),
    private val results: List<DaemonPidReadResult>? = null,
  ) : DaemonPidFileReader {
    private var reads = 0

    override fun read(): DaemonPidReadResult {
      val suppliedResults = results
      if (suppliedResults != null) {
        val index = reads.coerceAtMost(suppliedResults.lastIndex)
        reads++
        return suppliedResults[index]
      }
      val index = reads.coerceAtMost(versions.lastIndex)
      reads++
      return versions[index]?.let {
        DaemonPidReadResult.Present(DaemonPidState(it, launchArguments))
      } ?: DaemonPidReadResult.Absent
    }
  }

  private class FakeDaemonCommandExecutor(
    private val exitCode: Int = 0,
    private val output: String = "started",
    private val timedOut: Boolean = false,
  ) : DaemonCommandExecutor {
    val commands = mutableListOf<List<String>>()

    override fun execute(command: List<String>): DaemonCommandResult {
      commands += command
      return DaemonCommandResult(exitCode = exitCode, output = output, timedOut = timedOut)
    }
  }

  private class FakeDaemonPackageRunnerResolver(private val runner: String) :
    DaemonPackageRunnerResolver {
    override fun resolve(osName: String): String = runner
  }

  private class FakeDaemonRetryTimer : DaemonRetryTimer {
    val delays = mutableListOf<Long>()

    override fun sleep(milliseconds: Long) {
      delays += milliseconds
    }
  }
}
