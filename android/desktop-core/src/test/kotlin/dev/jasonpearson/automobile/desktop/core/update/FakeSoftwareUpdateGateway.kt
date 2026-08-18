package dev.jasonpearson.automobile.desktop.core.update

/**
 * A configurable [SoftwareUpdateGateway] for tests: returns a canned [probe] result (or throws),
 * reports a fixed [canApply], and records whether [apply] ran — so [ConveyorUpdateController] can
 * be exercised without a real Conveyor package.
 */
class FakeSoftwareUpdateGateway(
  private val probeResult: UpdateProbe = UpdateProbe.UpToDate,
  private val probeError: Exception? = null,
  private val canApply: Boolean = false,
  private val onApply: () -> Unit = {},
) : SoftwareUpdateGateway {

  var probed = false
    private set

  var applied = false
    private set

  override fun probe(): UpdateProbe {
    probed = true
    probeError?.let { throw it }
    return probeResult
  }

  override fun canApply(): Boolean = canApply

  override fun apply() {
    applied = true
    onApply()
  }
}
