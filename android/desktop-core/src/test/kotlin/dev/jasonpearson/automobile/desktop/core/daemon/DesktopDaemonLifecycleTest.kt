package dev.jasonpearson.automobile.desktop.core.daemon

import java.nio.file.Files
import java.nio.file.Path
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
    // A bare runner name (unresolved fallback) has no directory to publish onto PATH.
    assertEquals(listOf<String?>(null), commands.runnerDirectories)
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
    // bunx is self-contained: its directory is NOT published onto PATH, so the daemon's inherited
    // PATH order (and its bare-name tool resolution) is left untouched.
    assertEquals(listOf<String?>(null), commands.runnerDirectories)
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
        runnerDirectoryOf = { "/usr/local/bin" },
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Ready>(result)
    assertEquals(
      listOf(
        listOf("/usr/local/bin/npx", "-y", "@kaeawc/auto-mobile@0.0.40", "--daemon", "restart")
      ),
      commands.commands,
    )
    // The npx directory is published onto the child PATH so npx's `env node` shebang finds the
    // sibling `node` under a GUI-stripped PATH.
    assertEquals(listOf<String?>("/usr/local/bin"), commands.runnerDirectories)
  }

  @Test
  fun `resolveRunnerDirectory resolves npx to the node bin, not npm's script dir`() {
    // Standard nvm layout modeled in memory (no real, privilege-gated symlinks): node lives in
    // bin, bin/npx is a symlink into npm's script dir, and a /usr/local/bin shim links into bin.
    val nodeBin = Path.of("/opt/nvm/versions/node/v24/bin")
    val npmBin = Path.of("/opt/nvm/versions/node/v24/lib/node_modules/npm/bin")
    val nvmNpx = nodeBin.resolve("npx")
    val shimNpx = Path.of("/usr/local/bin/npx")
    val fs =
      FakeRunnerFileSystem(
        nodeFiles = setOf(nodeBin.resolve("node")),
        symlinks = mapOf(nvmNpx to npmBin.resolve("npx-cli.js"), shimNpx to nvmNpx),
      )

    // Direct nvm npx: node sits beside it. Must return the node bin, NOT npm/bin (the fully
    // canonical target's parent), which has no node.
    assertEquals(nodeBin.toString(), resolveRunnerDirectory(nvmNpx.toString(), fs))
    // A shim in /usr/local/bin that links into the nvm bin resolves to the nvm bin (one hop).
    assertEquals(nodeBin.toString(), resolveRunnerDirectory(shimNpx.toString(), fs))
    // A bare runner name (unresolved fallback) has no directory to publish.
    assertEquals(null, resolveRunnerDirectory("npx", fs))
    // No reachable node along the chain → null, so the caller never publishes a node-less dir.
    val emptyFs = FakeRunnerFileSystem(nodeFiles = emptySet(), symlinks = emptyMap())
    assertEquals(null, resolveRunnerDirectory("/usr/local/bin/npx", emptyFs))
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
  fun `prefers a PATH bunx over an absolute npx fallback`() {
    // Bun supplied on PATH by mise/asdf, npx present only at an absolute Homebrew path.
    val resolver =
      SystemDaemonPackageRunnerResolver(
        home = "/Users/dev",
        executableAt = { it == "/opt/homebrew/bin/npx" },
        listDir = { emptyList() },
        onPath = { runner, _ ->
          if (runner == "bunx") "/Users/dev/.local/share/mise/shims/bunx" else null
        },
      )

    assertEquals("/Users/dev/.local/share/mise/shims/bunx", resolver.resolve("Mac OS X"))
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
        fileSystem =
          fsWithNodeIn(
            "/Users/dev/.nvm/versions/node/v20.11.1/bin",
            "/Users/dev/.nvm/versions/node/v18.19.0/bin",
            "/Users/dev/.nvm/versions/node/v16.20.2/bin",
          ),
      )

    // Newest installed version wins over older ones and the Volta fallback.
    assertEquals("/Users/dev/.nvm/versions/node/v20.11.1/bin/npx", resolver.resolve("Mac OS X"))
  }

  @Test
  fun `prefers the stable nvm release over an installed release candidate`() {
    val resolver =
      SystemDaemonPackageRunnerResolver(
        home = "/Users/dev",
        executableAt = { it.startsWith("/Users/dev/.nvm/") },
        listDir = { dir ->
          if (dir == "/Users/dev/.nvm/versions/node")
            listOf("v20.11.1-rc.1", "v20.11.1", "v18.19.0")
          else emptyList()
        },
        onPath = { _, _ -> null },
        fileSystem =
          fsWithNodeIn(
            "/Users/dev/.nvm/versions/node/v20.11.1/bin",
            "/Users/dev/.nvm/versions/node/v18.19.0/bin",
          ),
      )

    // The stable release must win even though the RC's trailing number would sort it "newer".
    assertEquals("/Users/dev/.nvm/versions/node/v20.11.1/bin/npx", resolver.resolve("Mac OS X"))
  }

  @Test
  fun `skips a node-less npx and selects a working nvm install`() {
    val staleNpx = "/opt/homebrew/bin/npx"
    val nvmBin = "/Users/dev/.nvm/versions/node/v20.11.1/bin"
    val resolver =
      SystemDaemonPackageRunnerResolver(
        home = "/Users/dev",
        // Both npx binaries are executable, but only the nvm one has node beside it.
        executableAt = { it == staleNpx || it == "$nvmBin/npx" },
        listDir = { dir ->
          if (dir == "/Users/dev/.nvm/versions/node") listOf("v20.11.1") else emptyList()
        },
        onPath = { _, _ -> null },
        fileSystem = fsWithNodeIn(nvmBin),
      )

    // The stale Homebrew npx (no reachable node) is skipped rather than masking the working nvm.
    assertEquals("$nvmBin/npx", resolver.resolve("Mac OS X"))
  }

  @Test
  fun `falls back to a PATH runner then the npx name`() {
    val resolver =
      SystemDaemonPackageRunnerResolver(
        home = "/Users/dev",
        executableAt = { false },
        listDir = { emptyList() },
        onPath = { runner, _ -> if (runner == "npx") "/opt/npx" else null },
        // node lives beside the PATH-resolved npx, so it is usable.
        fileSystem = fsWithNodeIn("/opt"),
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
  fun `windows runner lookup skips the POSIX shim for the cmd shell`() {
    val pathExt = listOf(".COM", ".EXE", ".BAT", ".CMD")

    // `where npx` on stock Node-for-Windows lists the extensionless POSIX shim before npx.cmd;
    // cmd.exe /c can only run the .cmd, so it must be chosen.
    assertEquals(
      "C:\\Program Files\\nodejs\\npx.cmd",
      selectRunnerFromLookup(
        "C:\\Program Files\\nodejs\\npx\nC:\\Program Files\\nodejs\\npx.cmd\n",
        isWindows = true,
        pathExt,
      ),
    )
    // bunx.exe is chosen over any extensionless shim.
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
      "/usr/local/bin/npx",
      selectRunnerFromLookup("/usr/local/bin/npx\n", isWindows = false, pathExt),
    )
    // No PATHEXT match (unusual) falls back to the first line rather than returning null.
    assertEquals(
      "C:\\weird\\npx",
      selectRunnerFromLookup("C:\\weird\\npx\n", isWindows = true, pathExt),
    )
  }

  @Test
  fun `composes the child PATH with the runner directory first`() {
    val separator = java.io.File.pathSeparator

    assertEquals(
      "/opt/automobile/runner-bin${separator}/custom/bin",
      SystemDaemonCommandExecutor.composePath("/opt/automobile/runner-bin", "/custom/bin"),
    )
    assertEquals(
      "/opt/automobile/runner-bin",
      SystemDaemonCommandExecutor.composePath("/opt/automobile/runner-bin", null),
    )
    assertEquals(
      "/opt/automobile/runner-bin",
      SystemDaemonCommandExecutor.composePath("/opt/automobile/runner-bin", ""),
    )
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
    val runnerDirectories = mutableListOf<String?>()

    override fun execute(command: List<String>, runnerDirectory: String?): DaemonCommandResult {
      commands += command
      runnerDirectories += runnerDirectory
      return DaemonCommandResult(exitCode = exitCode, output = output, timedOut = timedOut)
    }
  }

  private class FakeDaemonPackageRunnerResolver(private val runner: String) :
    DaemonPackageRunnerResolver {
    override fun resolve(osName: String): String = runner
  }

  private class FakeRunnerFileSystem(
    private val nodeFiles: Set<Path>,
    private val symlinks: Map<Path, Path>,
  ) : RunnerFileSystem {
    override fun exists(path: Path): Boolean = path in nodeFiles || path in symlinks

    override fun isSymbolicLink(path: Path): Boolean = path in symlinks

    override fun readSymbolicLink(path: Path): Path = symlinks.getValue(path)
  }

  private fun fsWithNodeIn(vararg binDirs: String): FakeRunnerFileSystem =
    FakeRunnerFileSystem(
      nodeFiles = binDirs.map { Path.of(it).resolve("node") }.toSet(),
      symlinks = emptyMap(),
    )

  private class FakeDaemonRetryTimer : DaemonRetryTimer {
    val delays = mutableListOf<Long>()

    override fun sleep(milliseconds: Long) {
      delays += milliseconds
    }
  }
}
