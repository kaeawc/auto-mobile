package dev.jasonpearson.automobile.desktop.core.workspace.picker

import dev.jasonpearson.automobile.desktop.core.daemon.StartDeviceResult
import dev.jasonpearson.automobile.desktop.core.daemon.StartDeviceRuntime
import dev.jasonpearson.automobile.desktop.core.testing.FakeAutoMobileClient
import dev.jasonpearson.automobile.desktop.core.time.FakeDelayer
import dev.jasonpearson.automobile.desktop.core.workspace.Platform
import kotlinx.coroutines.ExperimentalCoroutinesApi
import kotlinx.coroutines.test.UnconfinedTestDispatcher
import kotlinx.coroutines.test.runTest
import org.junit.Assert.assertEquals
import org.junit.Assert.assertNull
import org.junit.Assert.assertTrue
import org.junit.Test

@OptIn(ExperimentalCoroutinesApi::class)
class RealDeviceBootControllerTest {

  private val device =
    PickerDevice(
      id = "Pixel_6_API_33",
      name = "Pixel 6 API 33",
      platform = Platform.Android,
      state = DeviceState.Shutdown,
    )

  private fun controller(client: FakeAutoMobileClient) =
    RealDeviceBootController(client, UnconfinedTestDispatcher())

  @Test
  fun `boot returns the daemon runtime id on success`() = runTest {
    val client =
      FakeAutoMobileClient().apply {
        startDeviceResult =
          StartDeviceResult(
            success = true,
            runtime = StartDeviceRuntime(deviceId = "emulator-5556"),
          )
      }
    assertEquals("emulator-5556", controller(client).boot(device).getOrNull())
  }

  @Test
  fun `boot rejects a success with no runtime deviceId instead of fabricating one`() = runTest {
    // Older daemons may omit deviceId. Fabricating the shut-down source id would fail the exact-id
    // match in reloadAfterBoot, so the device would read "Boot did not complete" while running.
    val client =
      FakeAutoMobileClient().apply {
        startDeviceResult = StartDeviceResult(success = true, deviceId = null)
      }
    val result = controller(client).boot(device)
    assertTrue(result.isFailure)
    assertNull(result.getOrNull()) // no fabricated id — surfaces a retryable failure instead
  }

  @Test
  fun `boot fails when the daemon reports failure`() = runTest {
    val client =
      FakeAutoMobileClient().apply {
        startDeviceResult = StartDeviceResult(success = false, message = "no matching device")
      }
    assertTrue(controller(client).boot(device).isFailure)
  }

  private fun refused(retryAfterMs: Long) =
    StartDeviceResult(success = false, message = "cleaning up", cleanupRetryAfterMs = retryAfterMs)

  @Test
  fun `boot waits out a cleanup refusal, reports it, then starts the device`() = runTest {
    val client =
      FakeAutoMobileClient().apply {
        queuedStartDeviceResults += refused(4_000)
        queuedStartDeviceResults += refused(2_000)
        startDeviceResult =
          StartDeviceResult(
            success = true,
            runtime = StartDeviceRuntime(deviceId = "emulator-5556"),
          )
      }
    val delayer = FakeDelayer()
    val states = mutableListOf<Boolean>()

    val result =
      RealDeviceBootController(client, UnconfinedTestDispatcher(), delayer).boot(device) {
        states += it
      }

    assertEquals("emulator-5556", result.getOrNull())
    assertEquals(listOf(4_000L, 2_000L), delayer.getPendingDelays())
    assertEquals(listOf(true, false, true, false), states)
    assertEquals(3, client.calls.count { it == "startDevice" })
  }

  @Test
  fun `boot gives up with the refusal once the cleanup wait budget is spent`() = runTest {
    val client = FakeAutoMobileClient().apply { startDeviceResult = refused(4_000) }
    val delayer = FakeDelayer()

    val result =
      RealDeviceBootController(
          client,
          UnconfinedTestDispatcher(),
          delayer,
          cleanupWaitBudgetMs = 6_000,
        )
        .boot(device)

    assertTrue(result.isFailure)
    assertEquals(listOf(4_000L, 2_000L), delayer.getPendingDelays())
    assertEquals(3, client.calls.count { it == "startDevice" })
  }
}
