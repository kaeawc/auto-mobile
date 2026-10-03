package dev.jasonpearson.automobile.junit

import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.Description
import org.junit.runner.notification.Failure
import org.junit.runner.notification.RunListener
import org.junit.runner.notification.RunNotifier

class DeviceAvailabilityCheckerTest {
  @get:Rule val temporaryFolder = TemporaryFolder()

  @Test
  fun unsetEnvironmentSkipsAndCachesCheck() {
    val lookups = mutableListOf<String>()
    val checker =
      DeviceAvailabilityChecker(
        getenv = { name ->
          lookups.add(name)
          null
        },
        commandExecutor = { _, _ -> error("No command should run without an SDK") },
      )

    checker.checkDeviceAvailability()
    assertFalse(checker.areDevicesAvailable())
    assertEquals(0, checker.getDeviceCount())
    assertEquals(MISSING_SDK_ERROR, checker.getLastError())
    checker.checkDeviceAvailability()
    assertEquals(listOf("ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_SDK_HOME"), lookups)
  }

  @Test
  fun unsetEnvironmentThroughLazyAvailabilityCheck() {
    val checker = unsetEnvironmentChecker()
    assertFalse(checker.areDevicesAvailable())
    assertEquals(0, checker.getDeviceCount())
    assertEquals(MISSING_SDK_ERROR, checker.getLastError())
  }

  @Test
  fun unsetEnvironmentThroughLazyDeviceCountCheck() {
    val checker = unsetEnvironmentChecker()
    assertEquals(0, checker.getDeviceCount())
    assertFalse(checker.areDevicesAvailable())
    assertEquals(MISSING_SDK_ERROR, checker.getLastError())
  }

  @Test
  fun sdkEnvironmentLookupUsesFirstSetVariable() {
    val sdkPath = temporaryFolder.newFolder("sdk").absolutePath
    val variables = listOf("ANDROID_HOME", "ANDROID_SDK_ROOT", "ANDROID_SDK_HOME")
    for ((index, variable) in variables.withIndex()) {
      val lookups = mutableListOf<String>()
      var commandCount = 0
      val checker =
        DeviceAvailabilityChecker(
          getenv = { name ->
            lookups.add(name)
            if (name == variable) sdkPath
            else if (variables.indexOf(name) > index) "invalid;" else null
          },
          commandExecutor = { command, timeoutMs ->
            commandCount++
            assertEquals(listOf("$sdkPath/platform-tools/adb", "devices"), command)
            assertEquals(10000L, timeoutMs)
            CommandResult(0, "List of devices attached\nemulator-5554\tdevice\n", "")
          },
        )

      assertTrue(checker.areDevicesAvailable())
      assertEquals(1, checker.getDeviceCount())
      assertNull(checker.getLastError())
      assertEquals(1, commandCount)
      assertEquals(variables.take(index + 1), lookups)
    }
  }

  @Test
  fun invalidConfiguredSdkStillThrows() {
    for (sdkPath in listOf("sdk;invalid", "sdk invalid")) {
      val checker =
        DeviceAvailabilityChecker(
          getenv = { sdkPath },
          commandExecutor = { _, _ -> error("Invalid SDK must not execute a command") },
        )
      val exception = assertFailsWith<IllegalStateException> { checker.checkDeviceAvailability() }
      assertEquals("ANDROID_HOME contains invalid characters", exception.message)
    }
  }

  @Test
  fun nonexistentConfiguredSdkStillThrows() {
    val sdkPath = temporaryFolder.root.resolve("missing-sdk").absolutePath
    val checker =
      DeviceAvailabilityChecker(
        getenv = { sdkPath },
        commandExecutor = { _, _ -> error("Nonexistent SDK must not execute a command") },
      )
    val exception = assertFailsWith<IllegalStateException> { checker.checkDeviceAvailability() }
    assertEquals("ANDROID_HOME path does not exist: $sdkPath", exception.message)
  }

  @Test
  fun runnerIgnoresEveryChildWithoutSdk() {
    AutoMobileSharedUtils.testDeviceChecker = unsetEnvironmentChecker()
    try {
      val ignored = mutableListOf<Description>()
      val failures = mutableListOf<Failure>()
      val started = mutableListOf<Description>()
      val notifier = RunNotifier()
      notifier.addListener(
        object : RunListener() {
          override fun testIgnored(description: Description) {
            ignored.add(description)
          }

          override fun testFailure(failure: Failure) {
            failures.add(failure)
          }

          override fun testStarted(description: Description) {
            started.add(description)
          }
        }
      )
      val runner = AutoMobileRunner(RunnerTestTarget::class.java)
      val children = runner.description.children
      assertEquals(2, children.size)
      runner.run(notifier)
      assertEquals(children.toSet(), ignored.toSet())
      assertEquals(children.size, ignored.size)
      assertTrue(failures.isEmpty())
      assertTrue(started.isEmpty())
    } finally {
      AutoMobileSharedUtils.testDeviceChecker = null
      SystemPropertyCache.clear()
      TestTimingCache.clear()
    }
  }

  private fun unsetEnvironmentChecker() =
    DeviceAvailabilityChecker(
      getenv = { null },
      commandExecutor = { _, _ -> error("No command should run without an SDK") },
    )

  companion object {
    private const val MISSING_SDK_ERROR =
      "ANDROID_HOME / ANDROID_SDK_ROOT is not set; cannot locate adb — treating as no devices available"
  }
}
