package dev.jasonpearson.automobile.desktop.core.update

import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFalse
import kotlin.test.assertIs
import kotlin.test.assertNull
import kotlin.test.assertTrue
import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.test.runTest

/** Maps a [SoftwareUpdateGateway] probe to [UpdateStatus] and delegates apply to the gateway. */
class ConveyorUpdateControllerTest {

  @Test
  fun `up-to-date probe yields UpToDate`() = runTest {
    val gateway = FakeSoftwareUpdateGateway(probeResult = UpdateProbe.UpToDate)
    val controller = ConveyorUpdateController(gateway)

    controller.checkForUpdate()

    assertTrue(gateway.probed)
    assertIs<UpdateStatus.UpToDate>(controller.status.value)
  }

  @Test
  fun `available probe yields UpdateAvailable with no asset or notes`() = runTest {
    val gateway = FakeSoftwareUpdateGateway(probeResult = UpdateProbe.Available("1.2.3"))
    val controller = ConveyorUpdateController(gateway)

    controller.checkForUpdate()

    val status = controller.status.value
    assertIs<UpdateStatus.UpdateAvailable>(status)
    assertEquals("1.2.3", status.version)
    // Conveyor owns the download; there is no per-asset URL or release-notes link to carry.
    assertNull(status.asset)
    assertNull(status.releaseNotesUrl)
  }

  @Test
  fun `probe failure yields Failed rather than throwing`() = runTest {
    val gateway =
      FakeSoftwareUpdateGateway(probeError = UpdateProbeException("repository unreachable"))
    val controller = ConveyorUpdateController(gateway)

    controller.checkForUpdate()

    val status = controller.status.value
    assertIs<UpdateStatus.Failed>(status)
    assertEquals("repository unreachable", status.reason)
  }

  @Test
  fun `cancellation during the probe restores the prior status and rethrows`() = runTest {
    // A CancellationException surfacing from the probe stands in for the coroutine being cancelled
    // mid-network-call: the controller must restore the last stable status (Idle) and rethrow,
    // never leave the shared StateFlow pinned at Checking.
    val gateway = FakeSoftwareUpdateGateway(probeError = CancellationException("cancelled"))
    val controller = ConveyorUpdateController(gateway)

    var rethrown = false
    try {
      controller.checkForUpdate()
    } catch (cancellation: CancellationException) {
      rethrown = true
    }

    assertTrue(rethrown)
    assertIs<UpdateStatus.Idle>(controller.status.value)
  }

  @Test
  fun `canApplyUpdate delegates to the gateway`() = runTest {
    assertTrue(
      ConveyorUpdateController(FakeSoftwareUpdateGateway(canApply = true)).canApplyUpdate()
    )
    assertFalse(
      ConveyorUpdateController(FakeSoftwareUpdateGateway(canApply = false)).canApplyUpdate()
    )
  }

  @Test
  fun `applyUpdate hands off to the gateway`() = runTest {
    val gateway = FakeSoftwareUpdateGateway(canApply = true)
    val controller = ConveyorUpdateController(gateway)

    controller.applyUpdate()

    assertTrue(gateway.applied)
  }
}
