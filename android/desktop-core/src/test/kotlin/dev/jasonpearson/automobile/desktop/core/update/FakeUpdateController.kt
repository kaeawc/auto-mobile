package dev.jasonpearson.automobile.desktop.core.update

import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow

/**
 * A no-op [UpdateController] for tests and previews: it holds a fixed [status] and never performs a
 * network check. Use it to satisfy the DI surface in tests that don't exercise update behavior.
 */
class FakeUpdateController(initial: UpdateStatus = UpdateStatus.Idle) : UpdateController {
  private val state = MutableStateFlow(initial)
  override val status: StateFlow<UpdateStatus> = state.asStateFlow()

  override suspend fun checkForUpdate() {
    // No-op: the fixed status stands in for a real check.
  }
}
