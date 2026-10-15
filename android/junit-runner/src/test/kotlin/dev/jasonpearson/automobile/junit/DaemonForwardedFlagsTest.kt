package dev.jasonpearson.automobile.junit

import org.junit.Assert.assertEquals
import org.junit.Assert.assertTrue
import org.junit.Test

class DaemonForwardedFlagsTest {

  private class FakeEnvironment(
    private val properties: Map<String, Boolean> = emptyMap(),
    private val variables: Map<String, String?> = emptyMap(),
  ) : DaemonFlagEnvironment {
    override fun flagProperty(name: String): Boolean = properties[name] ?: false

    override fun env(name: String): String? = variables[name]
  }

  @Test
  fun `table pins properties environment variables and flags in order`() {
    assertEquals(
      listOf(
        Triple(
          "automobile.daemon.dismiss.keyboard.after.input",
          "AUTOMOBILE_DAEMON_DISMISS_KEYBOARD_AFTER_INPUT",
          "--dismiss-keyboard-after-input",
        ),
        Triple(
          "automobile.daemon.no.ui.perf.mode",
          "AUTOMOBILE_DAEMON_NO_UI_PERF",
          "--no-ui-perf-mode",
        ),
        Triple(
          "automobile.daemon.no.navigation.screenshots",
          "AUTOMOBILE_DAEMON_NO_NAVIGATION_SCREENSHOTS",
          "--no-navigation-screenshots",
        ),
        Triple(
          "automobile.daemon.no.waitfor.polling.overhead",
          "AUTOMOBILE_DAEMON_NO_WAITFOR_POLLING_OVERHEAD",
          "--no-waitfor-polling-overhead",
        ),
        Triple(
          "automobile.daemon.no.include.not.important.views",
          "AUTOMOBILE_DAEMON_NO_INCLUDE_NOT_IMPORTANT_VIEWS",
          "--no-include-not-important-views",
        ),
        Triple(
          "automobile.daemon.no.report.view.ids",
          "AUTOMOBILE_DAEMON_NO_REPORT_VIEW_IDS",
          "--no-report-view-ids",
        ),
        Triple(
          "automobile.daemon.no.retrieve.interactive.windows",
          "AUTOMOBILE_DAEMON_NO_RETRIEVE_INTERACTIVE_WINDOWS",
          "--no-retrieve-interactive-windows",
        ),
      ),
      DAEMON_FORWARDED_FLAGS.map { Triple(it.systemProperty, it.envVar, it.cliFlag) },
    )
  }

  @Test
  fun `property alone enables each flag`() {
    DAEMON_FORWARDED_FLAGS.forEach { flag ->
      assertEquals(
        listOf(flag.cliFlag),
        forwardedDaemonFlags(FakeEnvironment(properties = mapOf(flag.systemProperty to true))),
      )
    }
  }

  @Test
  fun `accepted environment values enable each flag`() {
    listOf("1", "true", "yes", " TRUE ", "Yes").forEach { value ->
      DAEMON_FORWARDED_FLAGS.forEach { flag ->
        assertEquals(
          listOf(flag.cliFlag),
          forwardedDaemonFlags(FakeEnvironment(variables = mapOf(flag.envVar to value))),
        )
      }
    }
  }

  @Test
  fun `rejected environment values and false properties do not enable flags`() {
    DAEMON_FORWARDED_FLAGS.forEach { flag ->
      assertEquals(
        emptyList<String>(),
        forwardedDaemonFlags(FakeEnvironment(properties = mapOf(flag.systemProperty to false))),
      )
    }
    listOf("0", "false", "", "no", "2").forEach { value ->
      DAEMON_FORWARDED_FLAGS.forEach { flag ->
        assertEquals(
          emptyList<String>(),
          forwardedDaemonFlags(
            FakeEnvironment(
              properties = mapOf(flag.systemProperty to false),
              variables = mapOf(flag.envVar to value),
            ),
          ),
        )
      }
    }
  }

  @Test
  fun `all flags preserve table order and no flags returns empty`() {
    val allEnabled =
      FakeEnvironment(
        properties = DAEMON_FORWARDED_FLAGS.associate { it.systemProperty to true },
      )
    assertEquals(DAEMON_FORWARDED_FLAGS.map { it.cliFlag }, forwardedDaemonFlags(allEnabled))
    assertEquals(emptyList<String>(), forwardedDaemonFlags(FakeEnvironment()))
  }

  @Test
  fun `null environment values are disabled`() {
    DAEMON_FORWARDED_FLAGS.forEach { flag ->
      assertEquals(
        emptyList<String>(),
        forwardedDaemonFlags(FakeEnvironment(variables = mapOf(flag.envVar to null))),
      )
    }
  }

  @Test
  fun `start and restart commands append enabled forwarded flags`() {
    val environment =
      FakeEnvironment(variables = DAEMON_FORWARDED_FLAGS.associate { it.envVar to "yes" })
    val expectedFlags = DAEMON_FORWARDED_FLAGS.map { it.cliFlag }
    val start = DaemonSocketPaths.buildDaemonStartCommand(environment)
    val restart = DaemonSocketPaths.buildDaemonRestartCommand(environment)

    assertEquals(expectedFlags, start.takeLast(expectedFlags.size))
    assertTrue(start.contains("start"))
    assertEquals(expectedFlags, restart.takeLast(expectedFlags.size))
    assertTrue(restart.contains("restart"))
  }
}
