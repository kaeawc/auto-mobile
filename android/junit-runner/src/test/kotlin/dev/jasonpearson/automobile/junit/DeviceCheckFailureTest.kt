package dev.jasonpearson.automobile.junit

import java.io.IOException
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertNotNull
import kotlin.test.assertNull
import kotlin.test.assertTrue
import org.junit.After
import org.junit.Rule
import org.junit.Test
import org.junit.rules.TemporaryFolder
import org.junit.runner.Description
import org.junit.runner.notification.Failure
import org.junit.runner.notification.RunListener
import org.junit.runner.notification.RunNotifier

/**
 * A failed adb probe must be told apart from "adb ran and listed no devices" (#10171): the first is
 * an infrastructure failure that must not pass as a clean, fully skipped run.
 */
class DeviceCheckFailureTest {
  @get:Rule val temporaryFolder = TemporaryFolder()

  @After
  fun tearDown() {
    AutoMobileSharedUtils.testDeviceChecker = null
    SystemPropertyCache.clear()
    TestTimingCache.clear()
  }

  @Test
  fun exhaustedNonZeroProbeIsACheckFailure() {
    val checker = sdkChecker { CommandResult(1, "", "cannot connect to daemon") }

    assertFalse(checker.areDevicesAvailable())
    assertTrue(checker.checkFailed())
  }

  @Test
  fun probeExceptionAndTimeoutAreCheckFailures() {
    val exceptions =
      listOf(
        IOException("Cannot run program \"adb\": error=2, No such file or directory"),
        RuntimeException("Command execution timed out after 10000ms"),
      )
    for (exception in exceptions) {
      val checker = sdkChecker { throw exception }

      assertFalse(checker.areDevicesAvailable())
      assertTrue(checker.checkFailed())
    }
  }

  @Test
  fun successfulProbeWithNoDevicesIsNotACheckFailure() {
    val checker = sdkChecker { CommandResult(0, "List of devices attached\n", "") }

    assertFalse(checker.areDevicesAvailable())
    assertFalse(checker.checkFailed())
    assertNull(checker.getLastError())
  }

  @Test
  fun missingSdkIsNotACheckFailure() {
    val checker =
      DeviceAvailabilityChecker(
        getenv = { null },
        commandExecutor = { _, _ -> error("No command should run without an SDK") },
      )

    assertFalse(checker.areDevicesAvailable())
    assertFalse(checker.checkFailed())
  }

  @Test
  fun runnerFailsTheClassWithTheProbeDiagnosticInsteadOfIgnoringIt() {
    AutoMobileSharedUtils.testDeviceChecker =
      ScriptedDeviceChecker(lastError = "ADB device check failed (exit code 1)", failed = true)

    val events = runRunnerTarget()

    assertEquals(1, events.failures.size)
    val message = assertNotNull(events.failures.single().exception.message)
    assertTrue(message.contains("ADB device check failed (exit code 1)"))
    assertTrue(events.ignored.isEmpty())
    assertTrue(events.started.isEmpty())
  }

  @Test
  fun runnerStillIgnoresEveryChildWhenAdbListedNoDevices() {
    AutoMobileSharedUtils.testDeviceChecker =
      ScriptedDeviceChecker(lastError = null, failed = false)

    val events = runRunnerTarget()

    assertEquals(2, events.ignored.size)
    assertTrue(events.failures.isEmpty())
    assertTrue(events.started.isEmpty())
  }

  @Test
  fun executorNoDevicesMessageCarriesTheAdbDiagnostic() {
    AutoMobileSharedUtils.testDeviceChecker =
      ScriptedDeviceChecker(lastError = "ADB device check failed (exit code 1)", failed = true)

    val result =
      AutoMobilePlanExecutor.execute(
        "test-plans/launch-clock-app.yaml",
        emptyMap(),
        AutoMobilePlanExecutionOptions(maxRetries = 0, aiAssistance = false),
      )

    assertFalse(result.success)
    assertEquals(
      "No Android devices available for plan execution: ADB device check failed (exit code 1)",
      result.errorMessage,
    )
  }

  @Test
  fun executorNoDevicesMessageIsUnchangedWithoutADiagnostic() {
    assertEquals(
      "No Android devices available for plan execution",
      AutoMobilePlanExecutor.noDevicesMessage(null),
    )
  }

  private class RunEvents {
    val ignored = mutableListOf<Description>()
    val failures = mutableListOf<Failure>()
    val started = mutableListOf<Description>()
  }

  private fun runRunnerTarget(): RunEvents {
    val events = RunEvents()
    val notifier = RunNotifier()
    notifier.addListener(
      object : RunListener() {
        override fun testIgnored(description: Description) {
          events.ignored.add(description)
        }

        override fun testFailure(failure: Failure) {
          events.failures.add(failure)
        }

        override fun testStarted(description: Description) {
          events.started.add(description)
        }
      }
    )
    AutoMobileRunner(RunnerTestTarget::class.java).run(notifier)
    return events
  }

  private fun sdkChecker(commandExecutor: (List<String>) -> CommandResult) =
    temporaryFolder.newFolder().absolutePath.let { sdkPath ->
      DeviceAvailabilityChecker(
        getenv = { name -> if (name == "ANDROID_HOME") sdkPath else null },
        commandExecutor = { command, _ -> commandExecutor(command) },
        sleeper = {},
      )
    }
}

private class ScriptedDeviceChecker(private val lastError: String?, private val failed: Boolean) :
  DeviceChecker {
  override fun checkDeviceAvailability() = Unit

  override fun areDevicesAvailable(): Boolean = false

  override fun getDeviceCount(): Int = 0

  override fun getLastError(): String? = lastError

  override fun checkFailed(): Boolean = failed
}
