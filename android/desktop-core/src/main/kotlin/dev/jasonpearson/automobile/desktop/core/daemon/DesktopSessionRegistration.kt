package dev.jasonpearson.automobile.desktop.core.daemon

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/** Registration readiness shared by the session holder and its stream providers. */
class DesktopSessionRegistration(
  private val register: () -> Unit,
  private val heartbeat: () -> Unit,
) {
  private val ready = MutableStateFlow(false)
  val isRegistered: StateFlow<Boolean> = ready.asStateFlow()

  fun ensureRegistered() {
    if (!ready.value) {
      register()
      ready.value = true
    }
  }

  /**
   * True once the daemon acknowledged a `setActiveDevice` for this session (#10659). A refused bind
   * leaves the device with another session, so it must not count as a hold to release.
   */
  @Volatile
  var holdsDevice: Boolean = false
    private set

  /** The session may authenticate streams; [held] is whether the daemon actually bound a device. */
  fun deviceBound(held: Boolean = true) {
    ready.value = true
    if (held) holdsDevice = true
  }

  fun heartbeat() {
    runCatching { heartbeat.invoke() }.onFailure { ready.value = false }.getOrThrow()
  }

  fun clear() {
    ready.value = false
    holdsDevice = false
  }
}
