package dev.jasonpearson.automobile.desktop.core.daemon

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
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(false, true)),
        pidFileReader = FakeDaemonPidFileReader(listOf("0.0.40", "0.0.40")),
        commandExecutor = commands,
        timer = FakeDaemonRetryTimer(),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Ready>(result)
    assertTrue(result.restarted)
    assertEquals(
      listOf(listOf("npx", "-y", "@kaeawc/auto-mobile@0.0.40", "--daemon", "start")),
      commands.commands,
    )
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
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Ready>(result)
    assertTrue(result.restarted)
    assertEquals(
      listOf(listOf("npx", "-y", "@kaeawc/auto-mobile@0.0.40", "--daemon", "restart")),
      commands.commands,
    )
  }

  @Test
  fun `starts a version-pinned daemon when no socket exists`() {
    val commands = FakeDaemonCommandExecutor()
    val lifecycle =
      DesktopDaemonLifecycle(
        expectedVersionProvider = { "0.0.40" },
        socketChecker = FakeDaemonSocketChecker(listOf(false, true)),
        pidFileReader = FakeDaemonPidFileReader(listOf(null, "0.0.40")),
        commandExecutor = commands,
        timer = FakeDaemonRetryTimer(),
      )

    val result = lifecycle.ensureVersionMatchedDaemon()

    assertIs<DaemonLifecycleResult.Ready>(result)
    assertTrue(result.restarted)
    assertEquals(
      listOf(listOf("npx", "-y", "@kaeawc/auto-mobile@0.0.40", "--daemon", "start")),
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
  fun `uses the Windows npm command shim`() {
    val lifecycle = DesktopDaemonLifecycle()

    assertEquals("npx.cmd", lifecycle.npxExecutable("Windows 11"))
    assertEquals("npx", lifecycle.npxExecutable("Mac OS X"))
  }

  private class FakeDaemonSocketChecker(private val states: List<Boolean>) : DaemonSocketChecker {
    private var reads = 0

    override fun exists(): Boolean {
      val index = reads.coerceAtMost(states.lastIndex)
      reads++
      return states[index]
    }
  }

  private class FakeDaemonPidFileReader(private val versions: List<String?>) : DaemonPidFileReader {
    private var reads = 0

    override fun readVersion(): String? {
      val index = reads.coerceAtMost(versions.lastIndex)
      reads++
      return versions[index]
    }
  }

  private class FakeDaemonCommandExecutor(
    private val exitCode: Int = 0,
    private val output: String = "started",
  ) : DaemonCommandExecutor {
    val commands = mutableListOf<List<String>>()

    override fun execute(command: List<String>): DaemonCommandResult {
      commands += command
      return DaemonCommandResult(exitCode = exitCode, output = output)
    }
  }

  private class FakeDaemonRetryTimer : DaemonRetryTimer {
    val delays = mutableListOf<Long>()

    override fun sleep(milliseconds: Long) {
      delays += milliseconds
    }
  }
}
