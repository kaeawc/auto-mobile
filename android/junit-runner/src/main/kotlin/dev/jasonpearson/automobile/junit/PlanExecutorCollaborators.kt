package dev.jasonpearson.automobile.junit

/** Collaborators owned by one execution; constructing defaults never connects to a device. */
internal data class PlanExecutorCollaborators(
  val daemon: DaemonToolClient = DaemonSocketClientManager,
  val agent: () -> AutoMobileAgent = { LazyInitializer.getAgent(daemon) },
  val deviceChecker: DeviceChecker = LazyDeviceChecker,
  val heartbeat: DaemonHeartbeatController = DaemonHeartbeat,
  val timings: PlanExecutorTimings = PlanExecutorTimings(),
  /** Process environment, read for `ANDROID_SERIAL` device selection (#17953). */
  val environment: (String) -> String? = System::getenv,
  /** The daemon control socket this runner talks to, named in a failed plan's output (#17953). */
  val daemonEndpoint: () -> String = { DefaultDaemonEndpoint.socketPath },
)

/** Resolved once: it may shell out to `id -u`, and only failure output reads it. */
private object DefaultDaemonEndpoint {
  val socketPath: String by lazy { DaemonSocketPaths.socketPath() }
}

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
