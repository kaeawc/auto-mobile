package dev.jasonpearson.automobile.junit

import org.junit.After
import org.junit.Assert.assertFalse
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class DaemonSocketPathsFlagWiringTest {

  private val flagProperties = listOf(
      "automobile.daemon.dismiss.keyboard.after.input",
      "automobile.daemon.no.ui.perf.mode",
      "automobile.daemon.no.navigation.screenshots",
      "automobile.daemon.no.waitfor.polling.overhead",
  )

  @Before
  fun setUp() {
    flagProperties.forEach { System.clearProperty(it) }
    SystemPropertyCache.clear()
  }

  @After
  fun tearDown() {
    flagProperties.forEach { System.clearProperty(it) }
    SystemPropertyCache.clear()
  }

  @Test
  fun `buildDaemonStartCommand omits flags when no properties set`() {
    val command = DaemonSocketPaths.buildDaemonStartCommand()

    assertFalse(
        "should not contain --dismiss-keyboard-after-input",
        command.contains("--dismiss-keyboard-after-input"),
    )
    assertFalse(
        "should not contain --no-ui-perf-mode",
        command.contains("--no-ui-perf-mode"),
    )
    assertFalse(
        "should not contain --no-navigation-screenshots",
        command.contains("--no-navigation-screenshots"),
    )
    assertFalse(
        "should not contain --no-waitfor-polling-overhead",
        command.contains("--no-waitfor-polling-overhead"),
    )
  }

  @Test
  fun `buildDaemonStartCommand appends dismiss-keyboard flag when property true`() {
    System.setProperty("automobile.daemon.dismiss.keyboard.after.input", "true")
    SystemPropertyCache.clear()

    val command = DaemonSocketPaths.buildDaemonStartCommand()

    assertTrue(
        "should contain --dismiss-keyboard-after-input",
        command.contains("--dismiss-keyboard-after-input"),
    )
  }

  @Test
  fun `buildDaemonStartCommand appends no-ui-perf-mode flag when property true`() {
    System.setProperty("automobile.daemon.no.ui.perf.mode", "true")
    SystemPropertyCache.clear()

    val command = DaemonSocketPaths.buildDaemonStartCommand()

    assertTrue(
        "should contain --no-ui-perf-mode",
        command.contains("--no-ui-perf-mode"),
    )
  }

  @Test
  fun `buildDaemonStartCommand appends no-navigation-screenshots flag when property true`() {
    System.setProperty("automobile.daemon.no.navigation.screenshots", "true")
    SystemPropertyCache.clear()

    val command = DaemonSocketPaths.buildDaemonStartCommand()

    assertTrue(
        "should contain --no-navigation-screenshots",
        command.contains("--no-navigation-screenshots"),
    )
  }

  @Test
  fun `buildDaemonStartCommand appends no-waitfor-polling-overhead flag when property true`() {
    System.setProperty("automobile.daemon.no.waitfor.polling.overhead", "true")
    SystemPropertyCache.clear()

    val command = DaemonSocketPaths.buildDaemonStartCommand()

    assertTrue(
        "should contain --no-waitfor-polling-overhead",
        command.contains("--no-waitfor-polling-overhead"),
    )
  }

  @Test
  fun `buildDaemonStartCommand appends all flags when all properties set`() {
    System.setProperty("automobile.daemon.dismiss.keyboard.after.input", "true")
    System.setProperty("automobile.daemon.no.ui.perf.mode", "true")
    System.setProperty("automobile.daemon.no.navigation.screenshots", "true")
    System.setProperty("automobile.daemon.no.waitfor.polling.overhead", "true")
    SystemPropertyCache.clear()

    val command = DaemonSocketPaths.buildDaemonStartCommand()

    assertTrue(command.contains("--dismiss-keyboard-after-input"))
    assertTrue(command.contains("--no-ui-perf-mode"))
    assertTrue(command.contains("--no-navigation-screenshots"))
    assertTrue(command.contains("--no-waitfor-polling-overhead"))
  }

  @Test
  fun `buildDaemonStartCommand omits flags when properties are false`() {
    System.setProperty("automobile.daemon.dismiss.keyboard.after.input", "false")
    System.setProperty("automobile.daemon.no.ui.perf.mode", "false")
    System.setProperty("automobile.daemon.no.navigation.screenshots", "false")
    System.setProperty("automobile.daemon.no.waitfor.polling.overhead", "false")
    SystemPropertyCache.clear()

    val command = DaemonSocketPaths.buildDaemonStartCommand()

    assertFalse(command.contains("--dismiss-keyboard-after-input"))
    assertFalse(command.contains("--no-ui-perf-mode"))
    assertFalse(command.contains("--no-navigation-screenshots"))
    assertFalse(command.contains("--no-waitfor-polling-overhead"))
  }

  @Test
  fun `restart command also includes flags`() {
    System.setProperty("automobile.daemon.dismiss.keyboard.after.input", "true")
    SystemPropertyCache.clear()

    val command = DaemonSocketPaths.buildDaemonRestartCommand()

    assertTrue(command.contains("--dismiss-keyboard-after-input"))
    assertTrue(
        "restart subcommand should be present",
        command.contains("restart"),
    )
  }
}
