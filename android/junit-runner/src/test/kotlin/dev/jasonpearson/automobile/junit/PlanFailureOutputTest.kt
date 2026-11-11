package dev.jasonpearson.automobile.junit

import kotlinx.serialization.json.JsonPrimitive
import org.junit.Assert.assertEquals
import org.junit.Assert.assertFalse
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

/** A failed plan's `output` names the error, daemon and device; ANDROID_SERIAL pins (#17953). */
internal class PlanFailureOutputTest : PlanExecutorTestFixture() {

  private val noAi = AutoMobilePlanExecutionOptions(aiAssistance = false)

  @Test
  fun `a daemon connect failure carries the error, socket and device in output`() {
    fakeDaemonClient.setResponse(
      "executePlan",
      DaemonResponse(
        id = "",
        type = "mcp_response",
        success = false,
        error = "AutoMobile daemon connect failed: Connection refused",
      ),
    )

    val result = executePlan(noAi)

    assertFalse(result.success)
    assertTrue(result.output, result.output.contains("Connection refused"))
    assertTrue(result.output, result.output.contains(FAKE_DAEMON_SOCKET))
    assertTrue(result.output, result.output.contains("Device: auto"))
  }

  @Test
  fun `an exception before the daemon answers still fills output`() {
    // No executePlan response is configured, so the fake daemon throws.
    val result = executePlan(noAi)

    assertFalse(result.success)
    assertTrue(result.output, result.output.contains("Plan execution failed"))
    assertTrue(result.output, result.output.contains(FAKE_DAEMON_SOCKET))
  }

  @Test
  fun `no available devices fails with the probe error in output`() {
    collaborators = collaborators.copy(deviceChecker = FakeDeviceChecker(devicesAvailable = false))

    val result = executePlan(noAi)

    assertFalse(result.success)
    assertTrue(result.output, result.output.contains("No Android devices available"))
  }

  @Test
  fun `a successful plan output is left untouched`() {
    fakeDaemonClient.setResponse("executePlan", capturedToolResultsResponse())

    val result = executePlan(noAi)

    assertTrue(result.success)
    assertFalse(result.output, result.output.contains(FAKE_DAEMON_SOCKET))
  }

  @Test
  fun `ANDROID_SERIAL pins the plan when the device option is auto`() {
    fakeEnv[PlanDeviceSelection.ANDROID_SERIAL_ENV] = "emulator-5558"
    fakeDaemonClient.setResponse("executePlan", capturedToolResultsResponse())

    executePlan(noAi)

    assertEquals(
      JsonPrimitive("emulator-5558"),
      fakeDaemonClient.lastExecutePlanArguments?.get("deviceId"),
    )
  }

  @Test
  fun `an explicit device option wins over ANDROID_SERIAL`() {
    fakeEnv[PlanDeviceSelection.ANDROID_SERIAL_ENV] = "emulator-5558"
    fakeDaemonClient.setResponse("executePlan", capturedToolResultsResponse())

    executePlan(noAi.copy(device = "emulator-5554"))

    assertEquals(
      JsonPrimitive("emulator-5554"),
      fakeDaemonClient.lastExecutePlanArguments?.get("deviceId"),
    )
  }

  @Test
  fun `without ANDROID_SERIAL the daemon chooses the device`() {
    fakeDaemonClient.setResponse("executePlan", capturedToolResultsResponse())

    executePlan(noAi)

    assertNull(fakeDaemonClient.lastExecutePlanArguments?.get("deviceId"))
  }

  @Test
  fun `a failed plan names the ANDROID_SERIAL device in output`() {
    fakeEnv[PlanDeviceSelection.ANDROID_SERIAL_ENV] = "emulator-5558"

    val result = executePlan(noAi)

    assertTrue(result.output, result.output.contains("Device: emulator-5558 (ANDROID_SERIAL"))
  }

  @Test
  fun `multi-device plans are never pinned by ANDROID_SERIAL`() {
    val env = mapOf(PlanDeviceSelection.ANDROID_SERIAL_ENV to "emulator-5558")
    val plan = "devices:\n  - label: a\n    platform: android\nsteps: []\n"

    assertNull(PlanDeviceSelection.resolveDeviceId("auto", plan, env::get))
    assertEquals(
      "emulator-5558",
      PlanDeviceSelection.resolveDeviceId("auto", "steps: []\n", env::get),
    )
  }

  @Test
  fun `ANDROID_SERIAL limits the runner to one device`() {
    val env = mapOf(PlanDeviceSelection.ANDROID_SERIAL_ENV to "emulator-5558")

    assertEquals(1, PlanDeviceSelection.usableDeviceCount(3, env::get))
    assertEquals(0, PlanDeviceSelection.usableDeviceCount(0, env::get))
    assertEquals(3, PlanDeviceSelection.usableDeviceCount(3) { null })
    assertEquals(3, PlanDeviceSelection.usableDeviceCount(3) { " " })
  }
}
