package dev.jasonpearson.automobile.junit

import org.junit.After
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Before
import org.junit.Test

class DaemonSocketPathsFlagWiringTest {

  private val flagProperties =
    listOf(
      "automobile.daemon.dismiss.keyboard.after.input",
      "automobile.daemon.no.ui.perf.mode",
      "automobile.daemon.no.navigation.screenshots",
      "automobile.daemon.no.waitfor.polling.overhead",
      "automobile.daemon.package.version",
      "automobile.daemon.startup.timeout.ms",
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
  fun `daemon startup timeout defaults to 30 seconds`() {
    assertEquals(30_000L, DaemonSocketPaths.daemonStartTimeoutMs())
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

  @Test
  fun `bunx package command pins configured AutoMobile version`() {
    val command = DaemonSocketPaths.buildPackageDaemonCommand("bunx", "start", "0.0.32")

    assertEquals(
      listOf("bunx", "@kaeawc/auto-mobile@0.0.32", "--daemon", "start"),
      command,
    )
  }

  @Test
  fun `npx package command pins configured AutoMobile version with yes flag`() {
    val command = DaemonSocketPaths.buildPackageDaemonCommand("npx", "restart", "0.0.32")

    assertEquals(
      listOf("npx", "-y", "@kaeawc/auto-mobile@0.0.32", "--daemon", "restart"),
      command,
    )
  }

  @Test
  fun `npx command detection handles resolved executable paths`() {
    val command =
      DaemonSocketPaths.buildPackageDaemonCommand("/usr/local/bin/npx", "start", "0.0.32")

    assertEquals(
      listOf("/usr/local/bin/npx", "-y", "@kaeawc/auto-mobile@0.0.32", "--daemon", "start"),
      command,
    )
  }

  @Test
  fun `package command reads configured AutoMobile version from system property`() {
    System.setProperty("automobile.daemon.package.version", " 0.0.32 ")
    SystemPropertyCache.clear()

    val command = DaemonSocketPaths.buildPackageDaemonCommand("bunx", "start")

    assertEquals(
      listOf("bunx", "@kaeawc/auto-mobile@0.0.32", "--daemon", "start"),
      command,
    )
  }

  @Test
  fun `package command does not fall back to latest when version is absent`() {
    assertNull(
      "blank versions should not produce a package command",
      DaemonSocketPaths.buildPackageDaemonCommand("bunx", "start", " "),
    )
    assertNull(
      "unknown versions should not produce a package command",
      DaemonSocketPaths.buildPackageDaemonCommand("bunx", "start", "unknown"),
    )
    assertNull(
      "latest should not be used as a daemon package version",
      DaemonSocketPaths.buildPackageDaemonCommand("bunx", "start", "latest"),
    )
  }
}
