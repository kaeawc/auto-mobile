package dev.jasonpearson.automobile.desktop.core.workspace

import dev.jasonpearson.automobile.desktop.core.daemon.BuildContextStreamUpdate
import dev.jasonpearson.automobile.desktop.core.daemon.DeviceStreamEvent
import dev.jasonpearson.automobile.desktop.core.navigation.NavigationActiveContext
import dev.jasonpearson.automobile.desktop.core.navigation.ProvenanceBuildKey

/** Immutable pane-local build state, scoped to one device epoch and indexed by package. */
internal data class NavigationBuildKeyTracker(
  private val deviceId: String,
  private val keys: Map<String, ProvenanceBuildKey> = emptyMap(),
  private val sessionUuid: String? = null,
  private val hasSession: Boolean = false,
  private val staleReplay: BuildContextStreamUpdate? = null,
  private val retiredSessionUuid: String? = null,
) {
  fun updated(update: BuildContextStreamUpdate): NavigationBuildKeyTracker {
    if (update.deviceId != deviceId || update === staleReplay) return this
    if (update.deviceSessionUuid != null && update.deviceSessionUuid == retiredSessionUuid)
      return this
    val currentKeys =
      if (hasSession && sessionUuid != update.deviceSessionUuid) emptyMap() else keys
    val key = update.buildKey?.takeIf { it.packageId == update.packageId }
    val nextKeys =
      if (key == null) {
        currentKeys - update.packageId
      } else {
        currentKeys +
          (update.packageId to ProvenanceBuildKey(key.packageId, key.versionCode, key.contentHash))
      }
    return copy(keys = nextKeys, sessionUuid = update.deviceSessionUuid, hasSession = true)
  }

  /** Reject the buffered pre-reset object, while allowing a newly decoded daemon replay. */
  fun reset(replay: BuildContextStreamUpdate? = null): NavigationBuildKeyTracker =
    copy(keys = emptyMap(), sessionUuid = null, hasSession = false, staleReplay = replay)

  fun onDeviceEvent(
    event: DeviceStreamEvent,
    replay: BuildContextStreamUpdate? = null,
  ): NavigationBuildKeyTracker {
    if (event !is DeviceStreamEvent.DeviceSessionSuperseded || event.deviceId != deviceId)
      return this
    // Separate flows can deliver the successor's fresh key before the retirement event. Keep it.
    if (hasSession && sessionUuid == event.successorUuid) {
      return copy(retiredSessionUuid = event.retiredUuid)
    }
    // The replay cache may already contain a successor frame still waiting in its collector.
    return reset(replay?.takeIf { it.deviceSessionUuid != event.successorUuid })
      .copy(
        sessionUuid = event.successorUuid,
        hasSession = true,
        retiredSessionUuid = event.retiredUuid,
      )
  }

  fun activeContext(packageId: String): NavigationActiveContext =
    NavigationActiveContext(
      deviceId = deviceId,
      packageId = packageId,
      buildKey = keys[packageId]?.takeIf { it.packageId == packageId },
    )
}
