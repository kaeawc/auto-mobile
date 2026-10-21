package dev.jasonpearson.automobile.junit

/** Collaborators owned by one execution; constructing defaults never connects to a device. */
internal data class PlanExecutorCollaborators(
  val daemon: DaemonToolClient = DaemonSocketClientManager,
  val agent: () -> AutoMobileAgent = { LazyInitializer.getAgent(daemon) },
  val deviceChecker: DeviceChecker = LazyDeviceChecker,
  val heartbeat: DaemonHeartbeatController = DaemonHeartbeat,
  val timings: PlanExecutorTimings = PlanExecutorTimings(),
)

/** Preserve the shared checker's lazy initialization until a caller actually checks devices. */
private object LazyDeviceChecker : DeviceChecker {
  override fun checkDeviceAvailability() =
    AutoMobileSharedUtils.deviceChecker.checkDeviceAvailability()

  override fun areDevicesAvailable(): Boolean =
    AutoMobileSharedUtils.deviceChecker.areDevicesAvailable()

  override fun getDeviceCount(): Int = AutoMobileSharedUtils.deviceChecker.getDeviceCount()

  override fun getLastError(): String? = AutoMobileSharedUtils.deviceChecker.getLastError()

  override fun checkFailed(): Boolean = AutoMobileSharedUtils.deviceChecker.checkFailed()
}
