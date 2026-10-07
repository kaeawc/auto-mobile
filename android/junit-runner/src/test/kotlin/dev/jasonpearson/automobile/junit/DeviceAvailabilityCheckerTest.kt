package dev.jasonpearson.automobile.junit

import java.io.IOException
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
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

  @Test
  fun checkFailedIsTrueOnlyWhenAdbProbeFailed() {
    val failing =
      sdkChecker(
        commandExecutor = { _, _ -> CommandResult(1, "", "cannot connect to daemon") },
        sleeper = {},
      )
    assertTrue(failing.checkFailed())
    assertTrue(assertNotNull(failing.getLastError()).contains("Cannot connect to ADB daemon"))

    val timingOut =
      sdkChecker(commandExecutor = { _, _ -> throw RuntimeException("timed out") }, sleeper = {})
    assertTrue(timingOut.checkFailed())

    val empty =
      sdkChecker(
        commandExecutor = { _, _ -> CommandResult(0, "List of devices attached\n", "") },
        sleeper = {},
      )
    assertFalse(empty.checkFailed())
    assertFalse(empty.areDevicesAvailable())

    assertFalse(unsetEnvironmentChecker().checkFailed())
  }

  @Test
  fun runnerFailsClassWhenDeviceCheckFailed() {
    AutoMobileSharedUtils.testDeviceChecker =
      object : DeviceChecker {
        override fun checkDeviceAvailability() = Unit

        override fun areDevicesAvailable() = false

        override fun getDeviceCount() = 0

        override fun getLastError() = "ADB device check failed (exit code 1)"

        override fun checkFailed() = true
      }
    try {
      val ignored = mutableListOf<Description>()
      val failures = mutableListOf<Failure>()
      val notifier = RunNotifier()
      notifier.addListener(
        object : RunListener() {
          override fun testIgnored(description: Description) {
            ignored.add(description)
          }

          override fun testFailure(failure: Failure) {
            failures.add(failure)
          }
        }
      )
      AutoMobileRunner(RunnerTestTarget::class.java).run(notifier)
      assertEquals(1, failures.size)
      assertTrue(failures[0].message.contains("ADB device check failed (exit code 1)"))
      assertTrue(ignored.isEmpty())
    } finally {
      AutoMobileSharedUtils.testDeviceChecker = null
      SystemPropertyCache.clear()
      TestTimingCache.clear()
    }
  }

  @Test
  fun documentedDeviceOutputCountsOnlyAvailableDevices() {
    for ((output, expectedCount) in deviceOutputProbes()) {
      var attempts = 0
      val delays = mutableListOf<Long>()
      val checker =
        sdkChecker(
          commandExecutor = { _, _ ->
            attempts++
            CommandResult(0, output, "")
          },
          sleeper = { delays.add(it) },
        )

      assertEquals(expectedCount, checker.getDeviceCount())
      assertEquals(expectedCount > 0, checker.areDevicesAvailable())
      assertNull(checker.getLastError())
      val shouldRetry = expectedCount == 0 && output.contains("connecting-serial\tconnecting")
      assertEquals(if (shouldRetry) 3 else 1, attempts)
      assertEquals(if (shouldRetry) listOf(500L, 1000L) else emptyList(), delays)
    }
  }

  @Test
  fun pureParserHandlesDocumentedDeviceOutput() {
    for ((output, expectedCount) in deviceOutputProbes()) {
      assertEquals(expectedCount, DeviceAvailabilityChecker.countAvailableDevices(output))
    }
  }

  @Test
  fun adbServerFailureRetriesWithInjectedBackoffThenSucceeds() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          if (attempts < 3) CommandResult(1, "", "ADB server didn't ACK")
          else CommandResult(0, AVAILABLE_DEVICE_OUTPUT, "")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(1, checker.getDeviceCount())
    assertTrue(checker.areDevicesAvailable())
    assertEquals(3, attempts)
    assertEquals(listOf(500L, 1000L), delays)
    assertNull(checker.getLastError())
  }

  @Test
  fun adbServerFailureExhaustsRetriesWithoutSleepingAfterLastAttempt() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          CommandResult(1, "", "ADB server didn't ACK")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(0, checker.getDeviceCount())
    assertFalse(checker.areDevicesAvailable())
    assertEquals(3, attempts)
    assertEquals(listOf(500L, 1000L), delays)
    val lastError = assertNotNull(checker.getLastError())
    assertTrue(lastError.contains("ADB server didn't ACK"))
  }

  @Test
  fun executorExceptionRetriesWithInjectedBackoffThenSucceeds() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          if (attempts == 1) throw IllegalStateException("Temporary execution failure")
          CommandResult(0, AVAILABLE_DEVICE_OUTPUT, "")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(1, checker.getDeviceCount())
    assertTrue(checker.areDevicesAvailable())
    assertEquals(2, attempts)
    assertEquals(listOf(500L), delays)
    assertNull(checker.getLastError())
  }

  @Test
  fun executorExceptionExhaustsRetriesAndPreservesMessage() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          throw IllegalStateException("Persistent execution failure")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(0, checker.getDeviceCount())
    assertFalse(checker.areDevicesAvailable())
    assertEquals(3, attempts)
    assertEquals(listOf(500L, 1000L), delays)
    assertEquals("Persistent execution failure", checker.getLastError())
  }

  @Test
  fun unknownFailureExhaustsRetriesWithBackoff() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          CommandResult(1, "", "error: something else")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(0, checker.getDeviceCount())
    assertFalse(checker.areDevicesAvailable())
    assertEquals(3, attempts)
    assertEquals(listOf(500L, 1000L), delays)
    val lastError = assertNotNull(checker.getLastError())
    assertTrue(lastError.contains("error: something else"))
  }

  @Test
  fun protocolFaultRetriesThenSucceeds() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          if (attempts == 1) {
            CommandResult(
              1,
              "",
              "error: protocol fault (couldn't read status): Connection reset by peer",
            )
          } else CommandResult(0, AVAILABLE_DEVICE_OUTPUT, "")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(1, checker.getDeviceCount())
    assertEquals(2, attempts)
    assertEquals(listOf(500L), delays)
    assertNull(checker.getLastError())
  }

  @Test
  fun daemonStartupRetriesThenSucceeds() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          if (attempts == 1) {
            CommandResult(1, "", "* daemon not running; starting now at tcp:5037")
          } else CommandResult(0, AVAILABLE_DEVICE_OUTPUT, "")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(1, checker.getDeviceCount())
    assertEquals(2, attempts)
    assertEquals(listOf(500L), delays)
    assertNull(checker.getLastError())
  }

  @Test
  fun daemonConnectionFailureExhaustsRetriesAndPreservesDiagnostic() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          CommandResult(1, "", "cannot connect to daemon")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(0, checker.getDeviceCount())
    assertFalse(checker.areDevicesAvailable())
    assertEquals(3, attempts)
    assertEquals(listOf(500L, 1000L), delays)
    val lastError = assertNotNull(checker.getLastError())
    assertTrue(lastError.contains("Cannot connect to ADB daemon"))
  }

  @Test
  fun stdoutDiagnosticIsUsedWhenStderrIsEmpty() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          CommandResult(1, "CANNOT CONNECT TO DAEMON", "")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(0, checker.getDeviceCount())
    assertEquals(3, attempts)
    assertEquals(listOf(500L, 1000L), delays)
    val lastError = assertNotNull(checker.getLastError())
    assertTrue(lastError.contains("Cannot connect to ADB daemon"))
  }

  @Test
  fun connectingDeviceRetriesThenBecomesAvailable() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          val output = if (attempts == 1) CONNECTING_DEVICE_OUTPUT else AVAILABLE_DEVICE_OUTPUT
          CommandResult(0, output, "")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(1, checker.getDeviceCount())
    assertEquals(2, attempts)
    assertEquals(listOf(500L), delays)
    assertNull(checker.getLastError())
  }

  @Test
  fun connectingDeviceExhaustsRetriesWithoutErrorOrFinalSleep() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          CommandResult(0, CONNECTING_DEVICE_OUTPUT, "")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(0, checker.getDeviceCount())
    assertFalse(checker.areDevicesAvailable())
    checker.checkDeviceAvailability()
    assertEquals(3, attempts)
    assertEquals(listOf(500L, 1000L), delays)
    assertNull(checker.getLastError())
  }

  @Test
  fun availableDeviceWithConnectingDeviceSucceedsWithoutRetry() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          CommandResult(0, "${AVAILABLE_DEVICE_OUTPUT}emulator-5556\tconnecting\n", "")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(1, checker.getDeviceCount())
    assertEquals(1, attempts)
    assertTrue(delays.isEmpty())
    assertNull(checker.getLastError())
  }

  @Test
  fun missingOrNonExecutableAdbStopsWithoutRetryAndCachesFailure() {
    val messages =
      listOf(
        "Cannot run program \"/x/platform-tools/adb\": error=2, No such file or directory",
        "Cannot run program \"/x/platform-tools/adb\": error=13, Permission denied",
      )
    for (message in messages) {
      var attempts = 0
      val delays = mutableListOf<Long>()
      val checker =
        sdkChecker(
          commandExecutor = { _, _ ->
            attempts++
            throw IOException(message)
          },
          sleeper = { delays.add(it) },
        )

      assertEquals(0, checker.getDeviceCount())
      assertFalse(checker.areDevicesAvailable())
      checker.checkDeviceAvailability()
      assertEquals(1, attempts)
      assertTrue(delays.isEmpty())
      val lastError = assertNotNull(checker.getLastError())
      assertTrue(lastError.contains("adb", ignoreCase = true))
      assertTrue(lastError.contains(message))
    }
  }

  @Test
  fun executionTimeoutExhaustsRetriesWithBackoff() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val message = "Command execution timed out after 10000ms"
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          throw RuntimeException(message)
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(0, checker.getDeviceCount())
    assertEquals(3, attempts)
    assertEquals(listOf(500L, 1000L), delays)
    assertEquals(message, checker.getLastError())
  }

  @Test
  fun laterResultDiagnosticReplacesEarlierException() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          if (attempts == 1) throw RuntimeException("boom")
          CommandResult(1, "", "protocol fault (couldn't read status)")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(0, checker.getDeviceCount())
    assertEquals(3, attempts)
    assertEquals(listOf(500L, 1000L), delays)
    val lastError = assertNotNull(checker.getLastError())
    assertTrue(lastError.contains("exit code 1"))
    assertTrue(lastError.contains("protocol fault"))
    assertFalse(lastError.contains("boom"))
  }

  @Test
  fun finalExceptionReplacesEarlierResultDiagnostic() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          if (attempts == 3) throw RuntimeException("final boom")
          CommandResult(1, "", "protocol fault (couldn't read status)")
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(0, checker.getDeviceCount())
    assertEquals(3, attempts)
    assertEquals(listOf(500L, 1000L), delays)
    assertEquals("final boom", checker.getLastError())
  }

  @Test
  fun exceptionWithoutMessageUsesClassNameAsDiagnostic() {
    var attempts = 0
    val delays = mutableListOf<Long>()
    val checker =
      sdkChecker(
        commandExecutor = { _, _ ->
          attempts++
          throw RuntimeException()
        },
        sleeper = { delays.add(it) },
      )

    assertEquals(0, checker.getDeviceCount())
    assertEquals(3, attempts)
    assertEquals(listOf(500L, 1000L), delays)
    assertEquals("java.lang.RuntimeException", checker.getLastError())
  }

  @Test
  fun constructorsPreserveOriginalDefaultArgumentAbi() {
    val constructors =
      DeviceAvailabilityChecker::class
        .java
        .declaredConstructors
        .map { constructor -> constructor.parameterTypes.map { it.simpleName } }
        .toSet()
    val expected =
      setOf(
        emptyList(),
        listOf("Function1"),
        listOf("Function1", "Function2"),
        listOf("Function1", "Function2", "Function1"),
        listOf("Function1", "Function2", "int", "DefaultConstructorMarker"),
      )

    assertEquals(
      expected,
      constructors,
      "DeviceAvailabilityChecker must preserve the original JVM constructors and synthetic default-argument ABI",
    )
  }

  private fun sdkChecker(
    commandExecutor: (List<String>, Long) -> CommandResult,
    sleeper: (Long) -> Unit,
  ): DeviceAvailabilityChecker {
    val sdkPath = temporaryFolder.newFolder().absolutePath
    return DeviceAvailabilityChecker(
      getenv = { name -> if (name == "ANDROID_HOME") sdkPath else null },
      commandExecutor = commandExecutor,
      sleeper = sleeper,
    )
  }

  // Format probes built from adb's documented format, not captured device output.
  private fun deviceOutputProbes(): List<Pair<String, Int>> {
    val nonDeviceRows =
      """
      offline-serial\toffline
      unauthorized-serial\tunauthorized
      no-permissions-serial\tno permissions (user in plugdev group; are your udev rules wrong?); see [http://developer.android.com/tools/device.html]
      authorizing-serial\tauthorizing
      bootloader-serial\tbootloader
      recovery-serial\trecovery
      sideload-serial\tsideload
      host-serial\thost
      connecting-serial\tconnecting
      """
        .trimIndent()
        .replace("\\t", "\t")
    return listOf(
      "List of devices attached\nemulator-5554\tdevice\nemulator-5556\tdevice\n" to 2,
      "$AVAILABLE_DEVICE_OUTPUT$nonDeviceRows\n" to 1,
      "List of devices attached\n$nonDeviceRows\n" to 0,
      "\r\nList of devices attached\r\n\r\nemulator-5554\tdevice\r\n\r\n" to 1,
      "List of devices attached\n\n" to 0,
      "" to 0,
      """
      * daemon not running; starting now at tcp:5037
      * daemon started successfully
      * device must not count as a serial
      List of devices attached
      emulator-5554\tdevice
      """
        .trimIndent()
        .replace("\\t", "\t") to 1,
      """
      List of devices attached
      emulator-5554          device product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:1
      emulator-5556          offline product:sdk_gphone64_arm64 model:sdk_gphone64_arm64 device:emu64a transport_id:2
      """
        .trimIndent() to 1,
    )
  }

  private fun unsetEnvironmentChecker() =
    DeviceAvailabilityChecker(
      getenv = { null },
      commandExecutor = { _, _ -> error("No command should run without an SDK") },
    )

  companion object {
    // Format probe built from adb's documented format, not captured device output.
    private const val AVAILABLE_DEVICE_OUTPUT = "List of devices attached\nemulator-5554\tdevice\n"
    private const val CONNECTING_DEVICE_OUTPUT =
      "List of devices attached\nemulator-5554\tconnecting\n"

    private const val MISSING_SDK_ERROR =
      "ANDROID_HOME / ANDROID_SDK_ROOT is not set; cannot locate adb — treating as no devices available"
  }
}
