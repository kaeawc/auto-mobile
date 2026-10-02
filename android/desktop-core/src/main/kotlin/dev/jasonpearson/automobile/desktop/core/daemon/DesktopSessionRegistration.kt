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

  fun deviceBound() {
    ready.value = true
  }

  fun heartbeat() {
    runCatching { heartbeat.invoke() }.onFailure { ready.value = false }.getOrThrow()
  }

  fun clear() {
    ready.value = false
  }
}
