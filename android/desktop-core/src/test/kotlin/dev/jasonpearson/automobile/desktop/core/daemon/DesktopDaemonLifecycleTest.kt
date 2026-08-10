package dev.jasonpearson.automobile.desktop.core.daemon

import java.nio.file.Files
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
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
        listOf("bunx", "@kaeawc/auto-mobile@0.0.40", "--daemon", "start", "--network-mockable")
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
        packageRunnerResolver = FakeDaemonPackageRunnerResolver("/opt/homebrew/bin/bunx"),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Ready>(result)
    assertTrue(result.restarted)
    assertEquals(
      listOf(listOf("/opt/homebrew/bin/bunx", "@kaeawc/auto-mobile@0.0.40", "--daemon", "restart")),
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
        packageRunnerResolver = FakeDaemonPackageRunnerResolver("bunx"),
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
        packageRunnerResolver = FakeDaemonPackageRunnerResolver("bunx"),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Failure>(result)
    assertTrue(result.message.contains("Install @kaeawc/auto-mobile@0.0.40"))
  }

  @Test
  fun `reports actionable guidance when bunx cannot be run`() {
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(false)),
        pidFileReader = FakeDaemonPidFileReader(listOf(null)),
        commandExecutor = ThrowingDaemonCommandExecutor("Cannot run program \"bunx\""),
        timer = FakeDaemonRetryTimer(),
        packageRunnerResolver = FakeDaemonPackageRunnerResolver("bunx"),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Failure>(result)
    assertTrue(result.message.contains("Install Bun so bunx is available"))
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
        packageRunnerResolver = FakeDaemonPackageRunnerResolver("bunx"),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Failure>(result)
    assertTrue(result.message.contains("Timed out"))
  }

  @Test
  fun `wraps the resolved runner in the Windows command shim`() {
    val lifecycle = DesktopDaemonLifecycle()

    assertEquals(
      listOf("cmd.exe", "/d", "/v:off", "/s", "/c", "\"\"bunx.exe\" \"restart\"\""),
      lifecycle.commandForPlatform(listOf("bunx.exe", "restart"), "Windows 11"),
    )
  }

  @Test
  fun `prefers the PATH bunx over a hard-coded install`() {
    val resolver =
      SystemDaemonPackageRunnerResolver(
        home = "/Users/dev",
        // A stale hard-coded ~/.bun/bin/bunx lingers, but the user has migrated to mise.
        executableAt = { it == "/Users/dev/.bun/bin/bunx" },
        onPath = { runner, _ ->
          if (runner == "bunx") "/Users/dev/.local/share/mise/shims/bunx" else null
        },
      )

    // The PATH-configured runner wins over the hard-coded install.
    assertEquals("/Users/dev/.local/share/mise/shims/bunx", resolver.resolve("Mac OS X"))
  }

  @Test
  fun `falls back to a probed bun install when PATH is stripped`() {
    val resolver =
      SystemDaemonPackageRunnerResolver(
        home = "/Users/dev",
        executableAt = { it == "/Users/dev/.bun/bin/bunx" },
        // GUI-launched app: where/which resolves nothing against the stripped PATH.
        onPath = { _, _ -> null },
      )

    assertEquals("/Users/dev/.bun/bin/bunx", resolver.resolve("Mac OS X"))
  }

  @Test
  fun `discovers a linuxbrew bun install when PATH omits it`() {
    val linuxbrewBunx = "/home/linuxbrew/.linuxbrew/bin/bunx"
    val resolver =
      SystemDaemonPackageRunnerResolver(
        home = "/home/dev",
        // Bun is only under Linuxbrew, and the desktop-session PATH omits it.
        executableAt = { it == linuxbrewBunx },
        onPath = { _, _ -> null },
      )

    assertEquals(linuxbrewBunx, resolver.resolve("Linux"))
  }

  @Test
  fun `emits the bare bunx name when nothing resolves`() {
    val resolver =
      SystemDaemonPackageRunnerResolver(
        home = "/Users/dev",
        executableAt = { false },
        onPath = { _, _ -> null },
      )

    assertEquals("bunx", resolver.resolve("Mac OS X"))
    assertEquals("bunx.exe", resolver.resolve("Windows 11"))
  }

  @Test
  fun `windows runner lookup selects a PATHEXT-executable bunx`() {
    val pathExt = listOf(".COM", ".EXE", ".BAT", ".CMD")

    // `where bunx` may list an extensionless entry before bunx.exe; cmd.exe /c can only run the
    // PATHEXT entry, so it must be chosen.
    assertEquals(
      "C:\\Users\\dev\\.bun\\bin\\bunx.exe",
      selectRunnerFromLookup(
        "C:\\Users\\dev\\.bun\\bin\\bunx\nC:\\Users\\dev\\.bun\\bin\\bunx.exe\n",
        isWindows = true,
        pathExt,
      ),
    )
    // POSIX `which` returns an already-executable path; take the first.
    assertEquals(
      "/Users/dev/.bun/bin/bunx",
      selectRunnerFromLookup("/Users/dev/.bun/bin/bunx\n", isWindows = false, pathExt),
    )
    // No PATHEXT match on Windows → null, so the resolver falls back to the absolute bunx.exe.
    assertNull(selectRunnerFromLookup("C:\\weird\\bunx\n", isWindows = true, pathExt))
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

  private class ThrowingDaemonCommandExecutor(private val message: String) : DaemonCommandExecutor {
    override fun execute(command: List<String>): DaemonCommandResult =
      throw java.io.IOException(message)
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
